/**
 * POST /upload/receipt  multipart field "receipt" (+ optional "expenseId")
 * → { url }. When expenseId is given the receipt is attached immediately
 * (same permission rules as editing the line).
 */

import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../../auth/middleware.js';
import { updateExpense } from '../../domain/claims.js';
import { DomainError } from '../../domain/errors.js';
import { uploadReceipt } from '../../storage/index.js';
import { ah } from '../util.js';

export const uploadRouter = Router();

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);
const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new DomainError('Receipts must be a JPG, PNG, WebP, HEIC or PDF file.', 'invalid'));
  },
});

uploadRouter.post(
  '/upload/receipt',
  requireAuth,
  upload.single('receipt'),
  ah(async (req, res) => {
    if (!req.file) throw new DomainError('No file received (field name must be "receipt").', 'invalid');

    const expenseId = typeof req.body.expenseId === 'string' && req.body.expenseId ? req.body.expenseId : null;
    // Derive extension from the validated mime type, never from the client's filename
    const { url } = await uploadReceipt(req.file.buffer, `receipt${EXT[req.file.mimetype]}`);

    if (expenseId) {
      await updateExpense(expenseId, req.user!.id, { receipt_url: url }, 'web');
    }
    res.json({ url, attached: Boolean(expenseId) });
  }),
);
