-- A household has one local Cash account. It is not a Plaid account.
CREATE UNIQUE INDEX accounts_one_cash ON accounts(type) WHERE type = 'cash';
