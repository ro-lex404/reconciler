import pandas as pd
import random
from faker import Faker
from datetime import datetime, timedelta
from pathlib import Path


data_dir = Path(__file__).resolve().parent / 'data'
data_dir.mkdir(parents=True, exist_ok=True)

fake = Faker('en_IN')
random.seed(42)

base_date = datetime(2026, 7, 1)
records = []

for i in range(150):
    date = base_date + timedelta(days=random.randint(0, 30))
    amount = round(random.choice([
        random.uniform(100, 999),
        random.uniform(1000, 9999),
        random.uniform(10000, 50000)
    ]), 2)
    ref = f"REF{1000 + i}"
    records.append({
        "payment_id": f"pay_{fake.bothify('??##??##??')}",
        "amount": amount,
        "date": date.strftime('%Y-%m-%d'),
        "status": "SUCCESS",
        "merchant_ref": ref,
        "merchant_category": random.choice([
            "retail", "food", "travel", "electronics", "services"
        ])
    })

df_razorpay = pd.DataFrame(records)

# Bank statement — 150 rows, inject problems
bank_records = []
for i, row in df_razorpay.iterrows():
    problem = random.random()
    if i < 8:        # 8 missing bank entries — skip
        continue
    elif i < 13:     # 5 amount mismatches
        amount = row['amount'] + random.choice([10, -10, 50, -50])
    elif i < 16:     # 3 date mismatches
        date = (datetime.strptime(row['date'], '%Y-%m-%d') 
                + timedelta(days=4)).strftime('%Y-%m-%d')
        amount = row['amount']
    else:
        amount = row['amount']
        date = row['date']
    
    bank_records.append({
        "bank_ref": f"NEFT/2026/{fake.bothify('######')}",
        "value_date": row['date'] if i >= 16 else date,
        "credit_amount": amount,
        "description": f"RZRPY/{row['merchant_ref']}",
        "utr_number": row['merchant_ref'].replace('REF', '')
    })

# Add 3 ghost credits (bank entries with no Razorpay record)
for _ in range(3):
    bank_records.append({
        "bank_ref": f"NEFT/2026/{fake.bothify('######')}",
        "value_date": fake.date_between(
            start_date=base_date, 
            end_date=base_date + timedelta(days=30)
        ).strftime('%Y-%m-%d'),
        "credit_amount": round(random.uniform(500, 5000), 2),
        "description": "UNKNOWN/CREDIT",
        "utr_number": fake.bothify('######')
    })

df_bank = pd.DataFrame(bank_records)

df_razorpay.to_csv(data_dir / 'razorpay_settlements.csv', index=False)
df_bank.to_csv(data_dir / 'bank_statement.csv', index=False)
print(f"Razorpay: {len(df_razorpay)} records")
print(f"Bank: {len(df_bank)} records")
print("Done")