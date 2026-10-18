# Synthetic receipt OCR fixtures

These word boxes were produced by Windows Media OCR from the synthetic receipt-a.png, receipt-b.png and blank.png images already under tests/fixtures/images. They contain invented test receipts only. Only provider/language, dimensions, elapsed time and line/word geometry are retained; no private path, account, token or real receipt is included. Parser tests use the geometry rather than the provider's column-ordered aggregate text.
