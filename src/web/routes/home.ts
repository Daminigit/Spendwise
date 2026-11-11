import { Router } from 'express';

export const homeRouter = Router();

homeRouter.get('/', (req, res) => {
  if (req.user) return res.redirect('/claims');
  res.render('index', { title: 'Spendwise — expense claims, run from Claude' });
});
