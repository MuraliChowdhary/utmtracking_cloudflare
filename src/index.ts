import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import { IncomingRequestCfProperties } from '@cloudflare/workers-types';
// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

interface Env {
  DB: any;
}

interface UrlRecord {
  id: number;
  shortId: string;
  originalUrl: string;
  totalClicks: number;
  uniqueClicks: number;
  visitorDetails: string; // Stored as JSON string
  createdAt: string;
  updatedAt: string;
}

interface VisitorDetail {
  visitorId: string;
  city: string;
}

const app = new Hono<{ Bindings: Env }>();

// CORS Preflight request handler
app.options('*', (c) => {
  return new Response(null, {
    headers: corsHeaders,
  });
});

// Health check endpoint
app.get('/health', (c) => {
  return c.text('Server is running', 200, { ...corsHeaders });
});

// Route to create a short URL
app.post('/shorten', async (c) => {
  const { originalUrl } = await c.req.json<{ originalUrl: string }>();

  if (!originalUrl) {
    return c.json({ error: 'originalUrl is required' }, 400, { ...corsHeaders });
  }

  const shortId = nanoid(8);
  const now = new Date().toISOString();

  try {
    await c.env.DB.prepare(`
      INSERT INTO urls (shortId, originalUrl, totalClicks, uniqueClicks, visitorDetails, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(shortId, originalUrl, 0, 0, JSON.stringify([]), now, now).run();

    return c.json({ shortUrl: `${new URL(c.req.url).origin}/${shortId}` }, 200, { ...corsHeaders });
  } catch (error: any) {
    console.error('Error creating short URL:', error);
    return c.json({ error: 'Failed to create short URL' }, 500, { ...corsHeaders });
  }
});

// Route to handle redirection
app.get('/:shortId', async (c) => {
  const shortId = c.req.param('shortId');

  try {
    const { results } = await c.env.DB.prepare(`
      SELECT * FROM urls WHERE shortId = ?
    `).bind(shortId).all();

    const urlRecord = (results as UrlRecord[])?.[0];

    

    if (urlRecord) {
      const redirectUrl = `https://utm.nextdevs.me/?shortId=${shortId}&originalUrl=${encodeURIComponent(urlRecord.originalUrl)}`;
      return Response.redirect(redirectUrl, 302);
    } else {
      return c.json({ message: 'URL not found' }, 404, { ...corsHeaders });
    }
  } catch (error: any) {
    console.error('Error redirecting:', error);
    return c.json({ error: 'Failed to redirect' }, 500, { ...corsHeaders });
  }
});

// Route to store visitor ID and city information
app.post('/store-visitor-id', async (c) => {
  const { visitorId, shortId, city: requestCity } = await c.req.json<{ visitorId: string; shortId: string; city?: string }>();

  if (!visitorId || !shortId) {
    return c.json({ error: 'visitorId and shortId are required' }, 400, { ...corsHeaders });
  }

  try {
   const { results } = await c.env.DB.prepare(`
      SELECT * FROM urls WHERE shortId = ?
    `).bind(shortId).all();

    const urlRecord = (results as UrlRecord[])?.[0];

    if (urlRecord) {
      let visitorDetails: VisitorDetail[] = JSON.parse(urlRecord.visitorDetails || '[]');
      let totalClicks = urlRecord.totalClicks + 1;
      let uniqueClicks = urlRecord.uniqueClicks;

      const isUniqueVisitor = !visitorDetails.some(v => v.visitorId === visitorId);

      if (isUniqueVisitor) {
        uniqueClicks += 1;
        const city =
          requestCity ||
          ((c.req.raw as Request & { cf?: IncomingRequestCfProperties }).cf?.city) ||
          'Unknown';
        visitorDetails.push({ visitorId, city });
      }

      await c.env.DB.prepare(`
        UPDATE urls
        SET totalClicks = ?, uniqueClicks = ?, visitorDetails = ?, updatedAt = ?
        WHERE shortId = ?
      `).bind(totalClicks, uniqueClicks, JSON.stringify(visitorDetails), new Date().toISOString(), shortId).run();

      return c.json({ success: true }, 200, { ...corsHeaders });
    } else {
      return c.json({ message: 'URL not found' }, 404, { ...corsHeaders });
    }
  } catch (error: any) {
    console.error('Error storing visitor ID:', error);
    return c.json({ error: 'Failed to store visitor ID' }, 500, { ...corsHeaders });
  }
});

export default app;