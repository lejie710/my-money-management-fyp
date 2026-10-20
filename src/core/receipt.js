const {
  currencyInfo,
  validDate,
  parseMoney,
  transactionFromDraft,
  validateLedger,
} = require('./model');
const MAX_OCR_WORDS = 3000,
  MAX_OCR_TEXT_LENGTH = 30000;
const currencies = ['MYR', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CNY'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function validateOcrResult(value) {
  const vision = value?.provider === 'google-cloud-vision';
  const confidence = (number) =>
    number === null || (Number.isFinite(number) && number >= 0 && number <= 1);
  const language = (value) =>
    typeof value === 'string' && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value);
  const languages = (rows) => {
    if (
      !Array.isArray(rows) ||
      rows.length > 16 ||
      rows.some((row) => !object(row) || !language(row.languageCode) || !confidence(row.confidence))
    )
      throw new Error('The OCR language metadata is invalid.');
    return rows.map((row) => ({ languageCode: row.languageCode, confidence: row.confidence }));
  };
  if (
    !object(value) ||
    value.version !== 1 ||
    (!vision && value.provider !== 'windows-media-ocr') ||
    (!vision && value.language !== 'en-US') ||
    (vision &&
      (!language(value.language) ||
        value.geometry !== 'axis-aligned-envelope-with-original-polygon' ||
        value.textAngle !== null ||
        !confidence(value.pageConfidence))) ||
    !Number.isInteger(value.width) ||
    !Number.isInteger(value.height) ||
    value.width < 1 ||
    value.height < 1 ||
    value.width > 16384 ||
    value.height > 16384 ||
    value.width * value.height > 40000000 ||
    !Number.isFinite(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    value.elapsedMs > 120000 ||
    !(
      value.textAngle === null ||
      (Number.isFinite(value.textAngle) && Math.abs(value.textAngle) <= 180)
    ) ||
    !Array.isArray(value.words) ||
    value.words.length > MAX_OCR_WORDS
  )
    throw new Error('The OCR response is invalid or too large.');
  const detectedLanguages = vision ? languages(value.detectedLanguages) : null;
  if (
    vision &&
    value.language !== (detectedLanguages.length === 1 ? detectedLanguages[0].languageCode : 'und')
  )
    throw new Error('The OCR language metadata is inconsistent.');
  let count = 0;
  const words = value.words.map((word) => {
    if (
      !object(word) ||
      typeof word.text !== 'string' ||
      !word.text.trim() ||
      word.text.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(word.text) ||
      !object(word.bounds)
    )
      throw new Error('The OCR word data is invalid.');
    const { x, y, width, height } = word.bounds;
    if (
      ![x, y, width, height].every(Number.isFinite) ||
      x < 0 ||
      y < 0 ||
      width <= 0 ||
      height <= 0 ||
      x + width > value.width + 1 ||
      y + height > value.height + 1
    )
      throw new Error('The OCR word geometry is invalid.');
    count += word.text.length;
    if (count > MAX_OCR_TEXT_LENGTH) throw new Error('The receipt contains too much text.');
    const output = { text: word.text.trim(), bounds: { x, y, width, height } };
    if (vision) {
      if (
        !confidence(word.confidence) ||
        !Array.isArray(word.polygon) ||
        word.polygon.length !== 4 ||
        word.polygon.some(
          (point) =>
            !object(point) ||
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.y) ||
            point.x < 0 ||
            point.y < 0 ||
            point.x > value.width + 1 ||
            point.y > value.height + 1,
        )
      )
        throw new Error('The OCR word metadata is invalid.');
      const xs = word.polygon.map((point) => point.x),
        ys = word.polygon.map((point) => point.y);
      if (
        Math.abs(Math.min(...xs) - x) > 0.000001 ||
        Math.abs(Math.min(...ys) - y) > 0.000001 ||
        Math.abs(Math.max(...xs) - x - width) > 0.000001 ||
        Math.abs(Math.max(...ys) - y - height) > 0.000001
      )
        throw new Error('The OCR polygon and bounds disagree.');
      Object.assign(output, {
        confidence: word.confidence,
        detectedLanguages: languages(word.detectedLanguages),
        polygon: word.polygon.map((point) => ({ x: point.x, y: point.y })),
      });
    }
    return output;
  });
  return freeze({
    version: 1,
    provider: value.provider,
    language: value.language,
    width: value.width,
    height: value.height,
    elapsedMs: value.elapsedMs,
    textAngle: value.textAngle,
    words,
    ...(vision
      ? { detectedLanguages, pageConfidence: value.pageConfidence, geometry: value.geometry }
      : {}),
  });
}
function groupOcrRows(value) {
  const result = validateOcrResult(value),
    groups = [];
  const words = [...result.words].sort(
    (a, b) =>
      a.bounds.y + a.bounds.height / 2 - (b.bounds.y + b.bounds.height / 2) ||
      a.bounds.x - b.bounds.x,
  );
  for (const word of words) {
    const b = word.bounds,
      center = b.y + b.height / 2;
    let best = null,
      distance = Infinity;
    for (let i = groups.length - 1; i >= 0; i--) {
      const row = groups[i],
        delta = Math.abs(center - row.center);
      if (center - row.center > Math.max(b.height, row.height) * 2) break;
      if (delta <= Math.max(2, Math.min(b.height, row.height) * 0.55) && delta < distance) {
        best = row;
        distance = delta;
      }
    }
    if (best) {
      best.words.push(word);
      best.center =
        best.words.reduce((sum, w) => sum + w.bounds.y + w.bounds.height / 2, 0) /
        best.words.length;
      best.height = best.words.reduce((sum, w) => sum + w.bounds.height, 0) / best.words.length;
    } else groups.push({ center, height: b.height, words: [word] });
  }
  return freeze(
    groups
      .sort((a, b) => a.center - b.center)
      .map((row, index) => {
        const ordered = row.words.sort((a, b) => a.bounds.x - b.bounds.x),
          x = Math.min(...ordered.map((w) => w.bounds.x)),
          y = Math.min(...ordered.map((w) => w.bounds.y)),
          right = Math.max(...ordered.map((w) => w.bounds.x + w.bounds.width)),
          bottom = Math.max(...ordered.map((w) => w.bounds.y + w.bounds.height));
        return {
          index,
          text: ordered.map((w) => w.text).join(' '),
          bounds: { x, y, width: right - x, height: bottom - y },
          words: ordered,
        };
      }),
  );
}
function receiptCurrency(rows) {
  const text = rows.map((row) => row.text).join('\n'),
    found = new Set(),
    issues = [];
  const patterns = {
    MYR: /(?:^|[^A-Za-z])(?:MYR|RM)(?=[^A-Za-z]|$)/gi,
    USD: /(?:^|[^A-Za-z])USD(?=[^A-Za-z]|$)|(?:^|[^A-Za-z])US\$/gi,
    EUR: /(?:^|[^A-Za-z])EUR(?=[^A-Za-z]|$)|€/gi,
    GBP: /(?:^|[^A-Za-z])GBP(?=[^A-Za-z]|$)|£/gi,
    JPY: /(?:^|[^A-Za-z])JPY(?=[^A-Za-z]|$)|(?:^|[^A-Za-z])JP[¥￥]/gi,
    AUD: /(?:^|[^A-Za-z])AUD(?=[^A-Za-z]|$)|(?:^|[^A-Za-z])(?:A|AU)\$/gi,
    CAD: /(?:^|[^A-Za-z])CAD(?=[^A-Za-z]|$)|(?:^|[^A-Za-z])(?:C|CA)\$/gi,
    CNY: /(?:^|[^A-Za-z])(?:CNY|RMB)(?=[^A-Za-z]|$)|(?:^|[^A-Za-z])CN[¥￥]/gi,
  };
  let rest = text;
  for (const currency of currencies) {
    if (patterns[currency].test(text)) {
      found.add(currency);
      patterns[currency].lastIndex = 0;
      rest = rest.replace(patterns[currency], ' ');
    }
  }
  const explicit = [...found];
  if (rest.includes('$')) {
    issues.push('The dollar symbol does not identify USD, AUD or CAD.');
    for (const c of ['USD', 'AUD', 'CAD']) found.add(c);
  }
  if (/[¥￥]/.test(rest)) {
    issues.push('The yen/yuan symbol does not identify JPY or CNY.');
    for (const c of ['JPY', 'CNY']) found.add(c);
  }
  const candidates = [...found],
    unsupported = [
      ...new Set(
        [
          ...text.matchAll(
            /(?:^|[^A-Za-z])(SGD|HKD|THB|IDR|PHP|INR|KRW|VND|CHF|NZD|AED|SAR)(?=[^A-Za-z]|$)/gi,
          ),
        ].map((match) => match[1].toUpperCase()),
      ),
    ];
  if (unsupported.length)
    issues.push(
      `Unsupported currency code: ${unsupported.join(', ')}. Use manual entry in a matching currency.`,
    );
  if (!candidates.length)
    issues.push('No supported currency was identified. Confirm the wallet currency explicitly.');
  if (candidates.length > 1) issues.push('More than one currency interpretation is present.');
  return {
    suggested: candidates.length === 1 && !issues.length ? candidates[0] : null,
    candidates,
    explicit,
    unsupported,
    issues,
  };
}
function dateCandidates(rows, today) {
  const dates = new Set(),
    issues = [];
  let ambiguous = false;
  const add = (year, month, day) => {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (validDate(date)) {
      dates.add(date);
      return date;
    }
    return null;
  };
  for (const row of rows) {
    const matches = row.text.matchAll(/\b(\d{1,4})[\/.-](\d{1,2})[\/.-](\d{1,4})\b/g);
    for (const match of matches) {
      const [a, b, c] = match.slice(1),
        before = dates.size;
      if (a.length === 4) add(Number(a), Number(b), Number(c));
      else if (c.length === 4) {
        const first = add(Number(c), Number(b), Number(a)),
          second = add(Number(c), Number(a), Number(b));
        if (first && second && first !== second) ambiguous = true;
      } else issues.push('A two-digit year needs manual confirmation.');
      if (
        dates.size === before &&
        a.length === 4 &&
        !validDate(`${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`)
      )
        issues.push('An invalid calendar date was recognized.');
    }
  }
  const candidates = [...dates].sort();
  if (ambiguous) issues.push('Day and month order is ambiguous. Choose the intended date.');
  if (candidates.length > 1) issues.push('Several receipt dates were recognized.');
  if (candidates.some((date) => date > today))
    issues.push('A recognized date is later than today. Check it before using it.');
  if (!candidates.length) issues.push('No unambiguous calendar date was identified.');
  return {
    suggested: candidates.length === 1 && candidates[0] <= today ? candidates[0] : null,
    candidates,
    issues: [...new Set(issues)],
  };
}
function totals(rows, currency) {
  const candidates = [],
    issues = [];
  for (const row of rows) {
    if (
      !/\b(?:grand\s+total|amount\s+due|balance\s+due|total(?:\s+payable|\s+due)?)\b/i.test(
        row.text,
      ) ||
      /\b(?:sub[\s-]*total|subtotal|tax|vat|gst|sst|change|cash|tendered|discount|disc|saving(?:s)?|items?|qty|points)\b/i.test(
        row.text,
      )
    )
      continue;
    const label =
      /\b(?:grand\s+total|amount\s+due|balance\s+due|total(?:\s+payable|\s+due)?)\b/i.exec(
        row.text,
      );
    const trailing = row.text.slice(label.index + label[0].length);
    const rowCurrency = receiptCurrency([row]);
    if (rowCurrency.unsupported.length || rowCurrency.explicit.length > 1) {
      issues.push(
        'This total row has unsupported or mixed currency markers. Check its currency manually.',
      );
      continue;
    }
    const amountCurrency = rowCurrency.explicit[0] ?? currency;
    const matches = [...trailing.matchAll(/[-+]?\d+(?:[,.]\d+)*/g)];
    for (const match of matches) {
      let text = match[0];
      const prefix = /([A-Za-z]+)$/.exec(trailing.slice(0, match.index))?.[1]?.toUpperCase();
      const suffix = trailing.slice(match.index + text.length);
      const suffixCode = /^([A-Za-z]+)/.exec(suffix)?.[1]?.toUpperCase();
      if (
        (prefix && ![...currencies, 'RM', 'RMB'].includes(prefix)) ||
        (suffixCode && ![...currencies, 'RM', 'RMB'].includes(suffixCode))
      ) {
        issues.push('Unreadable characters next to a total need manual correction.');
        continue;
      }
      if (text.startsWith('-') || /\([^)]*\d[^)]*\)/.test(trailing)) {
        issues.push('A refund or negative total needs manual entry.');
        continue;
      }
      if (text.includes(',') && !/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(text)) {
        issues.push('A comma-decimal or ambiguous amount format needs manual entry.');
        continue;
      }
      try {
        const amountMinor = parseMoney(text.replace(/,/g, ''), amountCurrency);
        candidates.push({
          rowIndex: row.index,
          text: row.text,
          amountMinor,
          currency: amountCurrency,
        });
      } catch {
        issues.push('A recognized total has an invalid amount or exceeds the wallet limit.');
      }
    }
    if (!matches.length)
      issues.push('A total label was found without a readable amount on the same row.');
  }
  const unique = [...new Set(candidates.map((c) => c.amountMinor))];
  if (!unique.length) issues.push('No usable labelled total was identified.');
  if (unique.length > 1)
    issues.push('Several different labelled totals were recognized. Choose the correct amount.');
  return {
    suggestedMinor: unique.length === 1 && !issues.length ? unique[0] : null,
    candidates,
    issues: [...new Set(issues)],
  };
}
function parseReceipt(value, { walletCurrency, today }) {
  currencyInfo(walletCurrency);
  if (!validDate(today)) throw new Error('A valid current date is required for receipt review.');
  const ocr = validateOcrResult(value),
    rows = groupOcrRows(ocr),
    currency = receiptCurrency(rows),
    date = dateCandidates(rows, today),
    total = totals(rows, currency.suggested ?? walletCurrency),
    warnings = [
      'OCR suggestions can be wrong. Check every field against the image before continuing.',
    ];
  const header = rows.find(
    (row) =>
      /[A-Za-z\u00c0-\uffff]/.test(row.text) &&
      !/^\s*(?:receipt|tax\s+invoice|invoice|synthetic\s+test\s+receipt|date|total|subtotal)\b/i.test(
        row.text,
      ),
  );
  const title = {
    suggested: header && header.text.length <= 80 ? header.text : null,
    issues:
      header && header.text.length > 80
        ? ['The proposed vendor name is too long. Enter a shorter transaction title.']
        : header
          ? []
          : ['No vendor/title suggestion was identified.'],
  };
  if (currency.suggested && currency.suggested !== walletCurrency) {
    total.suggestedMinor = null;
    warnings.push(
      'The receipt currency differs from this wallet. No currency conversion has been performed.',
    );
  }
  if (!currency.suggested) total.suggestedMinor = null;
  if (ocr.textAngle !== null && Math.abs(ocr.textAngle) > 5)
    warnings.push('The receipt is rotated or skewed. Row matching may be unreliable.');
  if (ocr.provider === 'google-cloud-vision') {
    warnings.push(
      'Recognized by Google Cloud Vision. Suggestions still require your review; confidence scores do not prove the amount or date is correct.',
    );
    if (!/^en(?:-|$)/i.test(ocr.language))
      warnings.push(
        'Recognition includes an unknown or non-English language. Automatic receipt-field suggestions may be incomplete.',
      );
  }
  if (!rows.length)
    warnings.push('No text was recognized. Retake the image or enter the transaction manually.');
  return freeze({
    version: 1,
    provider: ocr.provider,
    reviewRequired: true,
    status: rows.length ? 'review' : 'empty',
    rows,
    title,
    date,
    currency,
    total,
    warnings,
  });
}
function reviewedReceiptTransaction(ledger, candidate, review, id) {
  validateLedger(ledger);
  if (
    !object(candidate) ||
    candidate.version !== 1 ||
    !['windows-media-ocr', 'google-cloud-vision'].includes(candidate.provider) ||
    candidate.reviewRequired !== true ||
    !object(review) ||
    review.confirmed !== true
  )
    throw new Error('Review the recognized fields and explicitly confirm them before continuing.');
  if (review.currency !== ledger.wallet.currency)
    throw new Error('Use this wallet currency. No receipt currency conversion is available.');
  if (candidate.currency?.unsupported?.length)
    throw new Error(
      'This receipt includes an unsupported currency. Use an explicitly reviewed manual transaction instead.',
    );
  if (
    candidate.currency?.explicit?.length &&
    !candidate.currency.explicit.includes(ledger.wallet.currency)
  )
    throw new Error(
      'The explicit receipt currency markers do not match this wallet. No currency conversion is available.',
    );
  if (candidate.currency?.suggested && candidate.currency.suggested !== ledger.wallet.currency)
    throw new Error(
      'This receipt uses another currency. It cannot be relabelled as the wallet currency.',
    );
  return transactionFromDraft(
    {
      type: 'expense',
      title: review.title,
      date: review.date,
      amount: review.amount,
      categoryId: review.categoryId,
    },
    id,
    ledger,
  );
}
module.exports = {
  MAX_OCR_WORDS,
  MAX_OCR_TEXT_LENGTH,
  validateOcrResult,
  groupOcrRows,
  parseReceipt,
  reviewedReceiptTransaction,
};
