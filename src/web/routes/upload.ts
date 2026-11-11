/**
 * POST /upload/receipt  multipart: "receipt" (file) + "expenseId"
 * → { url, attached: true }
 *
 * The caller must be allowed to edit the expense (owner on a draft, or the
 * approver on a submitted claim). The permission check runs BEFORE the file is
 * stored, and the file type is detected from its bytes, not the client's claim.
 */

import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../../auth/middleware.js';
import { loadEditableExpense, updateExpense } from '../../domain/claims.js';
import { DomainError } from '../../domain/errors.js';
import { MAX_RECEIPT_BYTES, UnsupportedFileError, uploadReceipt } from '../../storage/index.js';
import { ah } from '../util.js';

export const uploadRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_BYTES, files: 1, fields: 5 },
});

uploadRouter.post(
  '/upload/receipt',
  requireAuth,
  upload.single('receipt'),
  ah(async (req, res) => {
    const expenseId = typeof req.body.expenseId === 'string' ? req.body.expenseId.trim() : '';
    if (!expenseId) throw new DomainError('Missing expenseId: receipts are attached to an expense line.', 'invalid');
    if (!req.file) throw new DomainError('No file received (field name must be "receipt").', 'invalid');

    await loadEditableExpense(expenseId, req.user!.id);

    let url: string;
    try {
      ({ url } = await uploadReceipt(req.file.buffer));
    } catch (err) {
      if (err instanceof UnsupportedFileError) throw new DomainError(err.message, 'invalid');
      throw err;
    }

    await updateExpense(expenseId, req.user!.id, { receipt_url: url }, 'web');
    res.json({ url, attached: true });
  }),
);
