// Menu photos on catalogue items: upload, replace, clear, serve, and the
// refusals. Companion to lib/productImage.js.
//
// The fixtures below are REAL encoder output (ImageMagick), captured as base64
// so the suite stays hermetic — it needs no image tooling installed to run.
// That matters more than it sounds: the validator sniffs magic bytes and
// parses format headers, so hand-written byte arrays would only ever prove the
// parser agrees with itself. Ground truth for the dimensions asserted here came
// from `identify`, not from this code.
//
// NOTE ON WHAT MAKES THESE TESTS WORTH ANYTHING. A validator that rejected
// every payload would pass every negative test in the third describe. So each
// accepted format has a positive control that must SUCCEED — png, jpeg and
// webp all upload — and the refusals assert the specific REASON, not merely a
// 400. "Rejected" and "rejected for the right reason" are different claims and
// only the second one survives a refactor.
//
// Runs ONLY against a database whose name ends in _test — it truncates tables.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

if (!/_test(\?|$)/.test(process.env.DATABASE_URL || '')) {
  throw new Error('productImages.test.js requires a DATABASE_URL ending in _test');
}

// Point the store at a throwaway directory BEFORE app/env are imported —
// config/env.js reads process.env once at module load. Without this the suite
// would write into the lane's real upload directory and leave litter there.
const IMAGE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'vcx-menu-images-'));
process.env.POS_PRODUCT_IMAGE_DIR = IMAGE_DIR;

const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const { wipeAll } = await import('./helpers/wipe.js');
const { hashPassword } = await import('../src/lib/crypto.js');
const { MAX_IMAGE_BYTES, MAX_IMAGE_DIMENSION, PRODUCT_IMAGE_URL_PREFIX } = await import(
  '../src/lib/productImage.js'
);

// The prefix is asserted from the export rather than spelled out, so moving the
// mount cannot leave these tests passing against a path the app no longer uses.
// It has to stay under /api: that is the only prefix the dev proxy and the
// production nginx both forward here — see the note on the export itself.
const PREFIX = PRODUCT_IMAGE_URL_PREFIX;

const app = createApp();

// 8x8 solids, and a 2500x10 strip that is only 118 bytes — deliberately tiny,
// so it trips the dimension ceiling while sitting far under the byte ceiling.
// Without that separation a single "too big" test could not tell which of the
// two guards actually fired.
//
// Every one of these is a real file that `identify` accepts, not a hand-built
// header. An earlier version of the wide strip had a valid IHDR on a corrupt
// chunk stream: the dimension test passed, because the parser reads width and
// height at a fixed offset and never walks the chunks — passing for a reason
// that had nothing to do with what the test claimed to prove.
const PNG_8 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURcgeHv///zd0CksAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gkYDzQdMMZXVgAAAAtJREFUCNdjYEAFAAAQAAGhxSHBAAAAAElFTkSuQmCC';
const JPG_8 =
  '/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAIAAgDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AAIZLjf/2Q==';
const WEBP_8 =
  'UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoIAAgAAgA0JaACdLoAA5gA/vBsr/c1FbFvQ/9pZ/9Sz/6ln+KgAA==';
const PNG_2500x10 =
  'iVBORw0KGgoAAAANSUhEUgAACcQAAAAKCAMAAACn1z8YAAAAA1BMVEUeQK8H0kLcAAAALklEQVR42u3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvBlhsgABHy6ZdgAAAABJRU5ErkJggg==';

const dataUrl = (mime, b64) => `data:${mime};base64,${b64}`;

const PW = 'test-password-1';
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const tokens = {};
let companyA;
let productId;
let foreignProductId;

const login = async (email) => {
  const res = await request(app).post('/api/auth/login').send({ email, password: PW });
  expect(res.status, `login ${email}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body.token;
};

// Files currently on disk for a company, so a test can assert that a replaced
// photo left exactly one behind rather than accumulating.
const storedFiles = async (companyId) => {
  try {
    return (await fs.readdir(path.join(IMAGE_DIR, companyId))).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
};

const putImage = (id, token, url) =>
  request(app).put(`/api/catalog/products/${id}/image`).set(auth(token)).send({ dataUrl: url });

beforeAll(async () => {
  await wipeAll();
  const passwordHash = await hashPassword(PW);
  const inADay = new Date(Date.now() + 86400e3);

  companyA = await prisma.company.create({
    data: {
      name: 'Alpha Cafe',
      slug: 'mi-alpha-cafe',
      licenses: { create: { plan: 'MULTI_STORE', baseBranchLimit: 3, expiresAt: inADay } },
    },
  });
  const companyB = await prisma.company.create({
    data: {
      name: 'Bravo Cafe',
      slug: 'mi-bravo-cafe',
      licenses: { create: { plan: 'SINGLE_STORE', baseBranchLimit: 1, expiresAt: inADay } },
    },
  });
  const branchA1 = await prisma.branch.create({
    data: { companyId: companyA.id, publicId: 'VC-MI-0001', name: 'Alpha One', code: 'A1' },
  });

  const mk = (data) => prisma.posUser.create({ data: { passwordHash, ...data } });
  await mk({ email: 'mi.owner.a@test.local', fullName: 'Owner A', role: 'CUSTOMER_OWNER', companyId: companyA.id });
  await mk({
    email: 'mi.manager.a1@test.local',
    fullName: 'Manager A1',
    role: 'BRANCH_MANAGER',
    companyId: companyA.id,
    branchId: branchA1.id,
  });
  await mk({
    email: 'mi.cashier.a1@test.local',
    fullName: 'Cashier A1',
    role: 'CASHIER',
    companyId: companyA.id,
    branchId: branchA1.id,
  });
  await mk({ email: 'mi.owner.b@test.local', fullName: 'Owner B', role: 'CUSTOMER_OWNER', companyId: companyB.id });

  tokens.ownerA = await login('mi.owner.a@test.local');
  tokens.managerA1 = await login('mi.manager.a1@test.local');
  tokens.cashierA1 = await login('mi.cashier.a1@test.local');
  tokens.ownerB = await login('mi.owner.b@test.local');

  const category = await prisma.category.create({
    data: { companyId: companyA.id, name: 'Coffee', sortOrder: 1 },
  });
  const product = await prisma.product.create({
    data: { companyId: companyA.id, categoryId: category.id, name: 'Masala Chai', basePrice: '90.00' },
  });
  productId = product.id;

  const foreignCategory = await prisma.category.create({
    data: { companyId: companyB.id, name: 'Tea', sortOrder: 1 },
  });
  const foreignProduct = await prisma.product.create({
    data: { companyId: companyB.id, categoryId: foreignCategory.id, name: 'Bravo Chai', basePrice: '80.00' },
  });
  foreignProductId = foreignProduct.id;
});

afterAll(async () => {
  await prisma.$disconnect();
  await fs.rm(IMAGE_DIR, { recursive: true, force: true });
});

describe('putting a photo on a menu item', () => {
  it('stores the bytes, points the row at them, and shows them in the catalogue the till reads', async () => {
    const res = await putImage(productId, tokens.ownerA, dataUrl('image/png', PNG_8));
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const { imageUrl } = res.body.product;
    expect(imageUrl).toMatch(
      new RegExp(`^${PREFIX}/${companyA.id}/${productId}-[0-9a-f]{16}\\.png$`),
    );

    // The bytes on disk are the bytes that were sent — not merely a file of
    // the right name.
    // Derived by stripping the prefix, not by dropping a fixed number of
    // segments — the prefix has changed depth once already.
    const onDisk = await fs.readFile(
      path.join(IMAGE_DIR, imageUrl.slice(PREFIX.length + 1)),
    );
    expect(onDisk.equals(Buffer.from(PNG_8, 'base64'))).toBe(true);

    // The till renders the LIST endpoint, not the single-product one, so the
    // field has to survive that serializer too.
    const list = await request(app).get('/api/catalog/products').set(auth(tokens.ownerA));
    expect(list.status).toBe(200);
    expect(list.body.products.find((p) => p.id === productId).imageUrl).toBe(imageUrl);
  });

  it('accepts jpeg and webp too, so the sniffer is not simply refusing everything', async () => {
    const jpeg = await putImage(productId, tokens.ownerA, dataUrl('image/jpeg', JPG_8));
    expect(jpeg.status, JSON.stringify(jpeg.body)).toBe(200);
    expect(jpeg.body.product.imageUrl).toMatch(/\.jpg$/);

    const webp = await putImage(productId, tokens.ownerA, dataUrl('image/webp', WEBP_8));
    expect(webp.status, JSON.stringify(webp.body)).toBe(200);
    expect(webp.body.product.imageUrl).toMatch(/\.webp$/);
  });

  it('replaces rather than accumulates: the previous file is removed from disk', async () => {
    const first = await putImage(productId, tokens.ownerA, dataUrl('image/png', PNG_8));
    const firstUrl = first.body.product.imageUrl;
    expect(await storedFiles(companyA.id)).toEqual([path.basename(firstUrl)]);

    const second = await putImage(productId, tokens.ownerA, dataUrl('image/webp', WEBP_8));
    const secondUrl = second.body.product.imageUrl;
    expect(secondUrl).not.toBe(firstUrl);

    // Exactly one file, and it is the new one. A replace that left the old
    // file behind would grow the disk without bound as a shop re-shoots its
    // menu, which is the sort of leak nobody notices until the volume fills.
    expect(await storedFiles(companyA.id)).toEqual([path.basename(secondUrl)]);
  });

  it('is idempotent for identical bytes — the same photo twice is one file and one url', async () => {
    const once = await putImage(productId, tokens.ownerA, dataUrl('image/png', PNG_8));
    const twice = await putImage(productId, tokens.ownerA, dataUrl('image/png', PNG_8));
    expect(twice.body.product.imageUrl).toBe(once.body.product.imageUrl);
    expect(await storedFiles(companyA.id)).toEqual([path.basename(once.body.product.imageUrl)]);
  });

  it('clears the photo: the row goes back to null and the file leaves the disk', async () => {
    const set = await putImage(productId, tokens.ownerA, dataUrl('image/png', PNG_8));
    expect(set.body.product.imageUrl).not.toBeNull();

    const cleared = await request(app)
      .delete(`/api/catalog/products/${productId}/image`)
      .set(auth(tokens.ownerA));
    expect(cleared.status).toBe(200);
    // null, not "" or a placeholder path — the grid keys its no-photo tile off
    // exactly this.
    expect(cleared.body.product.imageUrl).toBeNull();
    expect(await storedFiles(companyA.id)).toEqual([]);
  });

  it('clearing a photo that was never set succeeds instead of erroring', async () => {
    const res = await request(app)
      .delete(`/api/catalog/products/${productId}/image`)
      .set(auth(tokens.ownerA));
    expect(res.status).toBe(200);
    expect(res.body.product.imageUrl).toBeNull();
  });
});

describe('who is allowed to change a menu photo', () => {
  it('refuses a cashier', async () => {
    const res = await putImage(productId, tokens.cashierA1, dataUrl('image/png', PNG_8));
    expect(res.status).toBe(403);
  });

  it('refuses a branch manager — catalogue writes are the owner\'s, and a photo is a catalogue write', async () => {
    const res = await putImage(productId, tokens.managerA1, dataUrl('image/png', PNG_8));
    expect(res.status).toBe(403);
  });

  it('will not let one company put a photo on another company\'s product, and writes nothing while refusing', async () => {
    const before = await storedFiles(companyA.id);
    const res = await putImage(foreignProductId, tokens.ownerA, dataUrl('image/png', PNG_8));
    // 404 rather than 403: the product must not be confirmed to exist at all.
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('POS_NOT_FOUND');

    // The tenant check runs BEFORE any byte is written, so a refused call
    // leaves no file anywhere — including under the caller's own company
    // directory, which is where a naive implementation would have put it.
    expect(await storedFiles(companyA.id)).toEqual(before);

    const foreign = await prisma.product.findUnique({ where: { id: foreignProductId } });
    expect(foreign.imageUrl).toBeNull();
  });

  it('refuses an anonymous caller', async () => {
    const res = await request(app)
      .put(`/api/catalog/products/${productId}/image`)
      .send({ dataUrl: dataUrl('image/png', PNG_8) });
    expect(res.status).toBe(401);
  });
});

describe('what the server refuses to store, and why', () => {
  const expectRefusal = async (url, pattern) => {
    const res = await putImage(productId, tokens.ownerA, url);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body.error.code).toBe('POS_BAD_REQUEST');
    // Asserting the reason, not the refusal: a guard that rejected everything
    // for one generic reason would pass a status-only check.
    expect(res.body.error.message).toMatch(pattern);
    return res;
  };

  it('rejects a payload that is not an image at all, however it labels itself', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    await expectRefusal(dataUrl('image/png', html), /not a JPEG, PNG or WebP/i);
  });

  it('rejects an SVG, which is a document that executes, not a picture', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    ).toString('base64');
    await expectRefusal(dataUrl('image/png', svg), /not a JPEG, PNG or WebP/i);
  });

  it('rejects real image bytes that lie about their type', async () => {
    // A genuine JPEG announced as image/png. Harmless in itself — the point is
    // that the server decides the type from the CONTENT, and says so, rather
    // than trusting the caller's label and writing a .png that is not one.
    await expectRefusal(dataUrl('image/png', JPG_8), /claims to be image\/png but the file is image\/jpeg/i);
  });

  it('rejects an image past the pixel ceiling even when its file is tiny', async () => {
    // 2500x10 in 177 bytes: it clears the byte limit comfortably, so only the
    // dimension guard can be what refuses it. This is the decompression-bomb
    // shape that would otherwise be handed to a till to rasterise.
    const res = await expectRefusal(dataUrl('image/png', PNG_2500x10), /2500x10/);
    expect(res.body.error.message).toContain(String(MAX_IMAGE_DIMENSION));
  });

  it('rejects a payload past the byte ceiling', async () => {
    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1024, 0x41).toString('base64');
    await expectRefusal(dataUrl('image/png', huge), /limit is \d+ KB/i);
  });

  it('rejects something that is not a data url', async () => {
    await expectRefusal('https://example.com/chai.png', /base64 data URL/i);
  });

  it('rejects corrupt base64 rather than writing a truncated file', async () => {
    await expectRefusal(dataUrl('image/png', `${PNG_8.slice(0, -4)}!!!!`), /base64 data URL|not valid base64/i);
  });

  it('rejects an empty payload', async () => {
    const res = await putImage(productId, tokens.ownerA, 'data:image/png;base64,');
    expect(res.status).toBe(400);
  });

  it('rejects a format we do not serve, even a real one', async () => {
    // A valid GIF header. GIFs animate, and an animating menu tile is a
    // distraction on a till, so the format is refused by omission rather than
    // by a special case — this proves the allowlist is an allowlist.
    const gif = Buffer.concat([
      Buffer.from('GIF89a', 'ascii'),
      Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]),
    ]).toString('base64');
    await expectRefusal(dataUrl('image/png', gif), /not a JPEG, PNG or WebP/i);
  });

  it('leaves the existing photo untouched when a replacement is refused', async () => {
    const good = await putImage(productId, tokens.ownerA, dataUrl('image/png', PNG_8));
    const keptUrl = good.body.product.imageUrl;

    const bad = await putImage(productId, tokens.ownerA, dataUrl('image/png', PNG_2500x10));
    expect(bad.status).toBe(400);

    // A failed edit must not cost the shop the photo it already had.
    const after = await request(app).get(`/api/catalog/products/${productId}`).set(auth(tokens.ownerA));
    expect(after.body.product.imageUrl).toBe(keptUrl);
    expect(await storedFiles(companyA.id)).toEqual([path.basename(keptUrl)]);
  });
});

describe('serving the stored photo', () => {
  it('serves the exact bytes, with a cacheable content type, to a caller with no session', async () => {
    const set = await putImage(productId, tokens.ownerA, dataUrl('image/png', PNG_8));
    const { imageUrl } = set.body.product;

    // No Authorization header on purpose: the customer display is a paired
    // device with no POS session, and an <img> tag cannot carry a bearer token
    // anyway. If this ever starts 401ing, the diner-facing screen goes blank.
    const res = await request(app).get(imageUrl);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.body.equals(Buffer.from(PNG_8, 'base64'))).toBe(true);
    // Content-addressed name, so this may be cached hard and forever.
    expect(res.headers['cache-control']).toMatch(/immutable/);
  });

  it('answers a missing photo in the POS error shape, not express.static\'s html', async () => {
    const res = await request(app).get(`${PREFIX}/${companyA.id}/does-not-exist.png`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('POS_NOT_FOUND');
  });

  it('does not serve anything outside the image directory', async () => {
    const res = await request(app).get(`${PREFIX}/../../package.json`);
    expect(res.status).not.toBe(200);
  });
});
