CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  category TEXT NOT NULL,
  item TEXT NOT NULL,
  amount REAL NOT NULL,
  payment TEXT,
  person TEXT,
  note TEXT
);

CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
