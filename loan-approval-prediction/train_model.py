"""Train comparable classifiers on the bundled, public loan approval dataset."""
from pathlib import Path
import json
import hashlib
from urllib.request import urlretrieve
import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, precision_score, recall_score, f1_score, roc_auc_score
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler

ROOT = Path(__file__).resolve().parent
DATA = ROOT / 'dataset' / 'loan_approval_dataset.csv'
DATA_URL = 'https://raw.githubusercontent.com/loh-0/Loan-Approval-Prediction/main/data/loan_approval_dataset.csv'
DATA_SHA256 = '7fd55001bd0b3ef6f5463506c4f13d2bdbe286c3f3cd4dd6fff5cded4055520f'
MODEL_DIR = ROOT / 'model'
FEATURES = ['no_of_dependents','education','self_employed','income_annum','loan_amount','loan_term','cibil_score','residential_assets_value','commercial_assets_value','luxury_assets_value','bank_asset_value']
NUM = ['no_of_dependents','income_annum','loan_amount','loan_term','cibil_score','residential_assets_value','commercial_assets_value','luxury_assets_value','bank_asset_value']
CAT = ['education','self_employed']

def build(kind):
    prep = ColumnTransformer([('num', Pipeline([('imputer', SimpleImputer(strategy='median')), ('scale', StandardScaler())]), NUM), ('cat', Pipeline([('imputer', SimpleImputer(strategy='most_frequent')), ('encode', OneHotEncoder(handle_unknown='ignore'))]), CAT)])
    clf = RandomForestClassifier(n_estimators=350, min_samples_leaf=2, class_weight='balanced', random_state=42) if kind == 'random_forest' else LogisticRegression(max_iter=2000, class_weight='balanced')
    return Pipeline([('preprocess', prep), ('classifier', clf)])

def main():
    if not DATA.exists():
        DATA.parent.mkdir(parents=True, exist_ok=True)
        urlretrieve(DATA_URL, DATA)
    if hashlib.sha256(DATA.read_bytes()).hexdigest() != DATA_SHA256:
        raise ValueError('Dataset SHA-256 mismatch; refusing to train on an unexpected file.')
    df = pd.read_csv(DATA)
    df.columns = df.columns.str.strip()
    df = df.drop_duplicates().copy()
    for col in FEATURES:
        if col in NUM: df[col] = pd.to_numeric(df[col], errors='coerce')
        else: df[col] = df[col].astype('string').str.strip().str.title()
    df['loan_status'] = df.loan_status.astype('string').str.strip().str.title()
    df = df[df.loan_status.isin(['Approved','Rejected'])].dropna(subset=['loan_status'])
    X, y = df[FEATURES], (df.loan_status == 'Approved').astype(int)
    Xtr, Xte, ytr, yte = train_test_split(X, y, test_size=.2, random_state=42, stratify=y)
    metrics, models = {}, {}
    for kind in ['random_forest','logistic_regression']:
        model = build(kind).fit(Xtr, ytr)
        pred = model.predict(Xte); prob = model.predict_proba(Xte)[:,1]
        metrics[kind] = {'accuracy': accuracy_score(yte,pred), 'precision': precision_score(yte,pred,zero_division=0), 'recall': recall_score(yte,pred,zero_division=0), 'f1': f1_score(yte,pred,zero_division=0), 'roc_auc': roc_auc_score(yte,prob)}
        models[kind] = model
    MODEL_DIR.mkdir(exist_ok=True)
    joblib.dump(models['random_forest'], MODEL_DIR/'random_forest.joblib')
    joblib.dump(models['logistic_regression'], MODEL_DIR/'logistic_regression.joblib')
    (MODEL_DIR/'metrics.json').write_text(json.dumps({'dataset': 'Loan Approval Prediction dataset (4,269 rows)', 'source': 'https://github.com/loh-0/Loan-Approval-Prediction/blob/main/data/loan_approval_dataset.csv', 'target': 'loan_status', 'rows_used': len(df), 'features': FEATURES, 'split': 'stratified 80/20, random_state=42', 'metrics': metrics}, indent=2))
    print(json.dumps(metrics, indent=2))

if __name__ == '__main__': main()

