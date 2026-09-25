// Permanent platform identifiers and the formats of the statutory numbers that
// sit beside them.
//
// An identifier minted here is never derived from anything the customer can
// edit. The series letters in a store id are a mnemonic frozen at creation, not
// a live claim about where the store is, so renaming a store, moving it to
// another GST registration or correcting its address leaves the id alone. That
// is the whole point of having it: the name is theirs to change, the id is what
// the invoice history, the support ticket and the device credential all point
// at.
//
// Minting uses PlatformCounter inside the caller's transaction — the same idiom
// InvoiceCounter already uses for bill numbers — so two stores created in the
// same instant cannot be handed the same number.

// GST numeric state code → series letters.
const STATE_SERIES = {
  '01': 'JK', '02': 'HP', '03': 'PB', '04': 'CH', '05': 'UK', '06': 'HR',
  '07': 'DL', '08': 'RJ', '09': 'UP', '10': 'BR', '11': 'SK', '12': 'AR',
  '13': 'NL', '14': 'MN', '15': 'MZ', '16': 'TR', '17': 'ML', '18': 'AS',
  '19': 'WB', '20': 'JH', '21': 'OD', '22': 'CG', '23': 'MP', '24': 'GJ',
  // 25 and 28 stopped being issued (Daman and Diu merged; Andhra Pradesh was
  // bifurcated) but GSTINs carrying them are still valid on old registrations,
  // so they resolve rather than falling through to XX.
  '25': 'DD', '26': 'DN', '27': 'MH', '28': 'AD', '29': 'KA', '30': 'GA',
  '31': 'LD', '32': 'KL', '33': 'TN', '34': 'PY', '35': 'AN', '36': 'TS',
  '37': 'AP', '38': 'LA', '97': 'OT',
};

export const STATE_NAME_BY_CODE = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab',
  '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi',
  '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam',
  '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh',
  '23': 'Madhya Pradesh', '24': 'Gujarat', '25': 'Daman and Diu',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra',
  '28': 'Andhra Pradesh (pre-2014)', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana',
  '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

// Free-text state name (lowercased) → series letters, for stores that carry a
// state string but no GST registration yet.
const NAME_SERIES = Object.fromEntries(
  Object.entries(STATE_NAME_BY_CODE).map(([code, name]) => [name.toLowerCase(), STATE_SERIES[code]]),
);

// A few spellings that turn up in real address fields and would otherwise miss.
Object.assign(NAME_SERIES, {
  'orissa': 'OD',
  'pondicherry': 'PY',
  'uttaranchal': 'UK',
  'new delhi': 'DL',
  'nct of delhi': 'DL',
  'delhi ncr': 'DL',
  'jammu & kashmir': 'JK',
  'andaman & nicobar islands': 'AN',
  'dadra & nagar haveli': 'DN',
  'dadra and nagar haveli': 'DN',
  'daman & diu': 'DD',
});

// XX is the honest fallback, not an error: a store with an unrecognised or
// absent state still deserves a permanent id, and guessing a state would put a
// wrong fact into something that can never be edited afterwards.
export const seriesFor = ({ stateCode, stateName } = {}) => {
  if (stateCode && STATE_SERIES[stateCode]) return STATE_SERIES[stateCode];
  const key = String(stateName || '').trim().toLowerCase();
  return NAME_SERIES[key] || 'XX';
};

export const stateNameFor = (stateCode) => STATE_NAME_BY_CODE[String(stateCode || '')] || null;

const next = async (tx, key) => {
  const counter = await tx.platformCounter.upsert({
    where: { key },
    update: { lastNumber: { increment: 1 } },
    create: { key, lastNumber: 1 },
  });
  return counter.lastNumber;
};

// "VC-DL-0001". Padded to 4 but unbounded above — the SQL shape CHECK allows
// growth past 9999 rather than capping a tenant at ten thousand stores in one
// state.
export const mintStorePublicId = async (tx, { stateCode, stateName } = {}) => {
  const series = seriesFor({ stateCode, stateName });
  const n = await next(tx, `store:${series}`);
  return `VC-${series}-${String(n).padStart(4, '0')}`;
};

// "VX-DVC-00002871". One global sequence: a device id is quoted to support, who
// must be able to find it without first being told which tenant owns it.
export const mintDevicePublicId = async (tx) => {
  const n = await next(tx, 'device');
  return `VX-DVC-${String(n).padStart(8, '0')}`;
};

// ---------------------------------------------------------------------------
// Statutory number formats. Defined once here because the same shapes are
// enforced in three places — the zod schema on the route, the CHECK constraint
// in the migration, and the admin screen's input pattern — and three copies
// that drift is how a GSTIN that the UI accepts starts failing at the database.
// ---------------------------------------------------------------------------

// 15 characters: 2 state + 10 PAN + 1 entity number + 'Z' + 1 checksum.
// The checksum digit is NOT verified here. Checking it would reject valid
// numbers if the algorithm is implemented even slightly wrong, and a wrong
// GSTIN that passes a checksum is still wrong — only the GST portal can say.
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

// 5 letters + 4 digits + 1 letter. The 4th letter encodes the constitution of
// the holder and the 5th is the first letter of the surname or entity name.
export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

// 21 characters, all digits, for a company incorporated in India: L/U + 5 digit
// industry code + 2 letter state + 4 digit year + 3 letter ownership + 6 digit
// registration number.
export const CIN_RE = /^[LUu][0-9]{5}[A-Za-z]{2}[0-9]{4}[A-Za-z]{3}[0-9]{6}$/;

// 14 digits. A registration (as opposed to a licence) is also 14 digits, so the
// shape cannot tell them apart and does not try to.
export const FSSAI_RE = /^[0-9]{14}$/;

// The PAN embedded in a GSTIN, characters 3–12. Used to tell a customer that
// the GSTIN they typed does not belong to the legal entity they picked — a real
// mistake, and one nothing else would catch until an invoice was already issued.
export const panFromGstin = (gstin) => {
  const s = String(gstin || '');
  return GSTIN_RE.test(s) ? s.slice(2, 12) : null;
};
