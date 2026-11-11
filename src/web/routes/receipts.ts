/**
 * GET /receipts/:name — stream a receipt image/PDF to someone allowed to see
 * the claim it belongs to (owner, owner's manager, org admin). Works the same
 * for local disk and a private S3/R2 bucket.
 */

import { Router } from 'express';
import { pipeline } from 'stream/promises';
import { requireAuth } from '../../auth/middleware.js';
import { assertCanViewReceipt } from '../../domain/claims.js';
import { DomainError } from '../../domain/errors.js';
import { isValidReceiptName, openReceipt, receiptUrlFor } from '../../storage/index.js';
import { ah } from '../util.js';

export const receiptsRouter = Router();

receiptsRouter.get(
  '/receipts/:name',
  requireAuth,
  ah(async (req, res) => {
    const name = String(req.params.name);
    if (!isValidReceiptName(name)) throw new DomainError('Receipt not found.', 'not_found');

    await assertCanViewReceipt(receiptUrlFor(name), req.user!.id);

    const file = await openReceipt(name);
    if (!file) throw new DomainError('Receipt file is missing from storage.', 'not_found');

    res.setHeader('Content-Type', file.contentType);
    if (file.size !== undefined) res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', `inline; filename="receipt-${name}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Belt and braces: never let a stored file run script in our origin
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");

    await pipeline(file.body, res);
  }),
);
