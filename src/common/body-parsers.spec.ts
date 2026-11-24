import express from 'express';
import request from 'supertest';
import { bodyParsers, ICON_PATH } from './body-parsers';

describe('bodyParsers', () => {
  const app = express();
  app.use(...bodyParsers());
  app.put(ICON_PATH, (_req, res) => {
    res.sendStatus(204);
  });
  app.post('/other', (_req, res) => {
    res.sendStatus(204);
  });
  const big = JSON.stringify({ png: 'a'.repeat(110_000) });

  it('accepts a ~110 kb body on the icon route', async () => {
    await request(app)
      .put(ICON_PATH)
      .set('Content-Type', 'application/json')
      .send(big)
      .expect(204);
  });

  it('keeps the 100 kb default elsewhere', async () => {
    await request(app)
      .post('/other')
      .set('Content-Type', 'application/json')
      .send(big)
      .expect(413);
  });
});
