# FinSight — Loan Approval Prediction and EMI Risk Analysis

A Flask + SQLite educational web application with a trained Random Forest approval classifier, Logistic Regression comparison, an EMI affordability view, searchable prediction history and downloadable PDF reports.

## Run locally

Requires Python 3.10+ (tested environment should use a supported Python release).

```bash
cd loan-approval-prediction
python -m venv .venv
# Windows PowerShell: .venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python train_model.py
python app.py
```

Open http://127.0.0.1:5000. Training creates `model/random_forest.joblib`, `model/logistic_regression.joblib`, and `model/metrics.json`; the SQLite database is initialized automatically on app start. Keep the training and serving scikit-learn versions aligned. Do not use Flask's development server or bundled secret key for deployment.

## Deploy to Render

Push the contents of this project folder to the root of a GitHub repository and select that repository when creating a Render service. The included `render.yaml` configures the build command (`pip install -r requirements.txt && python train_model.py`) and production server (`gunicorn app:app`). If the CSV is not included in the repository, training downloads the public dataset and verifies its SHA-256 before use. Render provides a public `onrender.com` URL after a successful deploy. The included SQLite database is local to the service; its records may be lost when the service restarts or redeploys unless persistent storage is configured.

## Dataset and honest feature scope

`dataset/loan_approval_dataset.csv` is a public educational dataset of 4,269 loan applications, with the fields `no_of_dependents`, `education`, `self_employed`, `income_annum`, `loan_amount`, `loan_term`, `cibil_score`, four asset values, and `loan_status`. Source: [dataset repository](https://github.com/loh-0/Loan-Approval-Prediction/blob/main/data/loan_approval_dataset.csv). The model does not learn age, existing EMIs, credit-history labels, gender, marital status, or monthly repayment capacity because these are absent from the dataset. The applicant's monthly household income is annualized to align with `income_annum`; monthly new-loan EMI is converted to whole-year term for the model while affordability uses the exact selected month count.

## Methodology

Both pipelines use numeric median and categorical most-frequent imputation, one-hot encoding, numeric scaling, and a stratified 80/20 holdout split (`random_state=42`). Accuracy, precision, recall, F1, and ROC AUC are recorded from the test split in `model/metrics.json`; no metric is claimed until `train_model.py` has actually run. Random Forest is the primary inference model; Logistic Regression is the comparison. Run the training script to reproduce the evaluation.

### Financial rules (separate from ML)

EMI is calculated with the reducing-balance formula `P × r × (1+r)^n / ((1+r)^n − 1)`, where `r` is monthly interest and `n` is number of months; at zero interest it is `P/n`. Total EMI = current EMI + proposed EMI. Remaining income = monthly household income − total EMI. EMI-to-income and debt-to-income ratio shown here both represent total EMI divided by household income. Explanation rules flag score below 650, reported poor history, EMI burden above 50%, negative remaining income, or a loan request above 60 months of income. These are explicit educational heuristics, not bank policy and not part of the trained model. Model estimate is never rewritten by these flags.

The displayed confidence is the predicted class probability, not a guarantee or calibrated lending score. This system is for coursework and education only, not actual lending.

