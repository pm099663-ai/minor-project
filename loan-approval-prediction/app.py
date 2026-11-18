from pathlib import Path
from datetime import datetime
import json, sqlite3, uuid, io
import joblib
import numpy as np
import pandas as pd
from flask import Flask, render_template, request, jsonify, send_file, abort

ROOT=Path(__file__).resolve().parent
app=Flask(__name__); app.config['SECRET_KEY']='change-this-for-deployment'
DB=ROOT/'database.db'; METRICS=json.loads((ROOT/'model'/'metrics.json').read_text()) if (ROOT/'model'/'metrics.json').exists() else {}
MODEL=joblib.load(ROOT/'model'/'random_forest.joblib') if (ROOT/'model'/'random_forest.joblib').exists() else None
FEATURES=['no_of_dependents','education','self_employed','income_annum','loan_amount','loan_term','cibil_score','residential_assets_value','commercial_assets_value','luxury_assets_value','bank_asset_value']
def connect():
    c=sqlite3.connect(DB); c.row_factory=sqlite3.Row; return c
def init_db():
    with connect() as c: c.execute('''CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY,name TEXT NOT NULL,amount REAL,result TEXT NOT NULL,confidence REAL NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL)''')
init_db()
def emi(principal, annual_rate, months):
    r=annual_rate/1200
    return principal/months if r==0 else principal*r*(1+r)**months/((1+r)**months-1)
def validate(d):
    required=['name','age','gender','marital_status','dependents','education','occupation','self_employed','salary','other_income','co_income','has_existing','loan_amount','purpose','tenure','interest','credit_score','credit_history','property_area']
    for k in required:
        if k not in d or str(d[k]).strip()=='': raise ValueError(f'{k.replace("_"," ").title()} is required.')
    choices={'gender':{'Female','Male','Prefer not to say'},'marital_status':{'Single','Married','Other'},'education':{'Graduate','Not Graduate'},'self_employed':{'Yes','No'},'has_existing':{'Yes','No'},'credit_history':{'Good','Poor','No History'},'property_area':{'Urban','Semiurban','Rural'},'purpose':{'Home','Personal','Education','Vehicle','Business','Other'}}
    for key, allowed in choices.items():
        if d[key] not in allowed: raise ValueError(f'Invalid {key.replace("_"," ")} selection.')
    def num(k,lo,hi):
        try: v=float(d[k])
        except: raise ValueError(f'{k.replace("_"," ").title()} must be a number.')
        if not lo<=v<=hi: raise ValueError(f'{k.replace("_"," ").title()} must be between {lo} and {hi}.')
        return v
    salary=num('salary',0,1e9); other=num('other_income',0,1e9); co=num('co_income',0,1e9)
    amt=num('loan_amount',1000,1e10); months=num('tenure',1,600); rate=num('interest',0,60); score=num('credit_score',300,900)
    age=num('age',18,100); dep=num('dependents',0,20)
    existing=bool(d['has_existing']=='Yes'); emi_old=num('existing_emi',0,1e9) if existing else 0; loans=int(num('existing_loans',1,50)) if existing else 0; balance=num('existing_balance',0,1e12) if existing else 0
    income=salary+other+co; proposed=emi(amt,rate,months); total=emi_old+proposed; remaining=income-total; ratio=100*total/income if income else 1000
    credit=d['credit_history']; repayment=remaining
    # Financial rules are a separate educational screen, not features learned by the approval model.
    dti=ratio
    return locals()
@app.get('/')
def index(): return render_template('index.html',metrics=METRICS)
@app.get('/dashboard')
def dashboard():
    with connect() as c:
        rows=c.execute('SELECT * FROM applications ORDER BY created_at DESC LIMIT 6').fetchall()
        total=c.execute('SELECT COUNT(*) FROM applications').fetchone()[0]
        approved=c.execute("SELECT COUNT(*) FROM applications WHERE result='Approved'").fetchone()[0]
    return render_template('dashboard.html',rows=rows,total=total,approved=approved,rejected=total-approved,rate=round(approved*100/total,1) if total else 0)
@app.get('/prediction')
def prediction(): return render_template('prediction.html')
@app.post('/predict')
def predict():
    if MODEL is None: return jsonify(error='Model not trained. Run: python train_model.py'),503
    try:
        d=request.get_json(force=True); x=validate(d)
        row={k:None for k in FEATURES}; row.update(no_of_dependents=x['dep'],education=d['education'].title(),self_employed=d['self_employed'].title(),income_annum=x['income']*12,loan_amount=x['amt'],loan_term=max(1,round(x['months']/12)),cibil_score=x['score'],residential_assets_value=float(d.get('residential_assets',0) or 0),commercial_assets_value=float(d.get('commercial_assets',0) or 0),luxury_assets_value=float(d.get('luxury_assets',0) or 0),bank_asset_value=float(d.get('bank_assets',0) or 0))
        p=float(MODEL.predict_proba(pd.DataFrame([{k:row[k] for k in FEATURES}]))[0][1]); result='Approved' if p>=.5 else 'Rejected'; conf=p if result=='Approved' else 1-p
        reasons=[]; positives=[]
        if x['score']<650: reasons.append('Credit score is below 650, a weaker range in this educational assessment.')
        else: positives.append('Credit score is at least 650.')
        if x['credit']=='Poor': reasons.append('Applicant reported poor credit history.')
        elif x['credit']=='Good': positives.append('Applicant reported good credit history.')
        if x['income']<=0: reasons.append('No monthly household income was reported.')
        if x['income']>0 and x['ratio']>50: reasons.append(f'Total EMI burden is {x["ratio"]:.1f}% of monthly household income (above the 50% educational guideline).')
        elif x['income']>0: positives.append(f'Total EMI burden is {x["ratio"]:.1f}% of monthly household income.')
        if x['remaining']<0: reasons.append('Proposed and existing EMIs exceed monthly household income.')
        if x['income'] and x['amt']>60*x['income']: reasons.append('Requested amount exceeds 60 months of reported household income.')
        if not reasons: reasons.append('The model classified this profile as rejected; compare its learned feature importances with the applicant profile.') if result=='Rejected' else None
        if not positives: positives.append('The model classified this profile as approved based on the training features.') if result=='Approved' else None
        # Observed rule flags are transparent; model output is learned from the bundled dataset.
        payload={'name':d['name'],'age':x['age'],'gender':d['gender'],'marital_status':d['marital_status'],'occupation':d['occupation'],'purpose':d['purpose'],'amount':x['amt'],'income':x['income'],'existing_emi':x['emi_old'],'proposed_emi':x['proposed'],'total_emi':x['total'],'remaining':x['remaining'],'ratio':x['ratio'],'dti':x['ratio'],'score':x['score'],'credit_history':x['credit'],'tenure_months':x['months'],'interest':x['rate'],'confidence':conf,'probability_approved':p,'result':result,'reasons':reasons,'positives':positives,'suggestions':['Reduce requested amount to lower the EMI.','Choose a longer tenure and compare total interest cost.','Reduce existing monthly EMI obligations where possible.','Build a positive credit history and correct credit report errors.','Increase the down payment to reduce the amount borrowed.'] if result=='Rejected' else ['Maintain timely repayments and keep total EMI obligations manageable.'],'model_name':'Random Forest','dataset_note':'The model was trained on annual income, requested amount, tenure in years, CIBIL score, education, self-employment, dependents, and asset values. Existing EMI and credit history labels are used in separate transparent rule analysis.'}
        aid='LA-'+datetime.now().strftime('%y%m%d')+'-'+uuid.uuid4().hex[:6].upper()
        with connect() as c: c.execute('INSERT INTO applications VALUES(?,?,?,?,?,?,?)',(aid,d['name'],x['amt'],result,conf,json.dumps(payload),datetime.now().isoformat(timespec='seconds')))
        return jsonify(id=aid,payload=payload)
    except (ValueError,KeyError) as e: return jsonify(error=str(e)),400
@app.get('/result/<aid>')
def result(aid):
    with connect() as c: row=c.execute('SELECT * FROM applications WHERE id=?',(aid,)).fetchone()
    if not row: abort(404)
    return render_template('result.html',row=row,p=json.loads(row['payload']))
@app.get('/history')
def history():
    q=request.args.get('q','').strip()
    with connect() as c: rows=c.execute('SELECT * FROM applications WHERE id LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT 100',(f'%{q}%',f'%{q}%')).fetchall()
    return render_template('history.html',rows=rows,q=q)
@app.get('/api/metrics')
def metrics(): return jsonify(METRICS)
@app.get('/api/emi')
def api_emi():
    try: return jsonify(emi(float(request.args['amount']),float(request.args['rate']),int(request.args['months'])))
    except: return jsonify(error='Invalid calculator inputs.'),400
@app.get('/report/<aid>.pdf')
def report(aid):
    with connect() as c: row=c.execute('SELECT * FROM applications WHERE id=?',(aid,)).fetchone()
    if not row: abort(404)
    try:
        from reportlab.lib.pagesizes import letter
        from reportlab.pdfgen import canvas
        buf=io.BytesIO(); pdf=canvas.Canvas(buf,pagesize=letter); y=740; p=json.loads(row['payload'])
        pdf.setFont('Helvetica-Bold',18); pdf.drawString(50,y,'Loan Approval Prediction Report'); y-=35; pdf.setFont('Helvetica',11)
        lines=[f"Application ID: {row['id']}",f"Applicant: {row['name']}",f"Prediction: {row['result']}",f"Model confidence: {row['confidence']:.1%}",f"Requested loan: {p['amount']:,.2f}",f"Monthly household income: {p['income']:,.2f}",f"Existing EMI: {p['existing_emi']:,.2f}",f"Proposed EMI: {p['proposed_emi']:,.2f}",f"Total EMI: {p['total_emi']:,.2f}",f"Remaining income: {p['remaining']:,.2f}",f"EMI-to-income ratio: {p['ratio']:.1f}%",'','Educational prediction only; this is not a bank lending decision.']
        for line in lines: pdf.drawString(50,y,line[:105]); y-=20
        pdf.save(); buf.seek(0); return send_file(buf,as_attachment=True,download_name=f'{aid}.pdf',mimetype='application/pdf')
    except ImportError: return 'Install reportlab to download PDF reports: pip install reportlab',501
@app.get('/about')
def about(): return render_template('about.html',metrics=METRICS)
if __name__=='__main__': app.run(debug=True)

