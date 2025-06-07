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
    visitorDetails: string;
    createdAt: string;
    updatedAt: string;
}

interface VisitorDetail {
    visitorId: string;
    city: string;
    country: string;
    timestamp: string;
    userAgent: string;
}

const app = new Hono<{ Bindings: Env }>();


app.options('*', (c) => {
    return new Response(null, {
        headers: corsHeaders,
    });
});


app.get('/health', (c) => {
    return c.text('Server is running', 200, { ...corsHeaders });
});


app.get('/urls', async (c) => {
    const page = parseInt(c.req.query('page') || '1');
    const limit = parseInt(c.req.query('limit') || '10');  
    const offset = (page - 1) * limit;

    if (isNaN(page) || page < 1 || isNaN(limit) || limit < 1) {
        return c.json({ error: 'Invalid page or limit parameters' }, 400, { ...corsHeaders });
    }

    try {
         
        const { results: urlRecords } = await c.env.DB.prepare(`
            SELECT shortId, originalUrl, totalClicks, uniqueClicks, createdAt, updatedAt
            FROM urls
            ORDER BY createdAt DESC
            LIMIT ? OFFSET ?
        `).bind(limit, offset).all();

        
        const { results: countResult } = await c.env.DB.prepare(`
            SELECT COUNT(*) as totalCount FROM urls
        `).all();
        const totalCount = (countResult?.[0] as { totalCount: number })?.totalCount || 0;
        const totalPages = Math.ceil(totalCount / limit);

        // --- Caching Logic for Paginated URLs ---
        // Cache this list for 1 minute (60 seconds).
        // This helps reduce D1 reads for dashboard views.
        return c.json({
            data: urlRecords,
            pagination: {
                totalCount,
                totalPages,
                currentPage: page,
                limit,
            }
        }, 200, {
            ...corsHeaders,
            'Cache-Control': 'public, max-age=60, s-maxage=60'
        });
        // --- End Caching Logic ---

    } catch (error: any) {
        console.error('Error fetching URLs:', error);
        return c.json({ error: 'Failed to fetch URLs' }, 500, { ...corsHeaders });
    }
});


app.post('/shorten', async (c) => {
    const { originalUrl } = await c.req.json<{ originalUrl: string }>();

    if (!originalUrl) {
        return c.json({ error: 'originalUrl is required' }, 400, { ...corsHeaders });
    }

    try {
        new URL(originalUrl);
    } catch {
        return c.json({ error: 'Invalid URL format' }, 400, { ...corsHeaders });
    }

    const shortId = nanoid(8);
    const now = new Date().toISOString();

    try {
        await c.env.DB.prepare(`
            INSERT INTO urls (shortId, originalUrl, totalClicks, uniqueClicks, visitorDetails, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(shortId, originalUrl, 0, 0, JSON.stringify([]), now, now).run();

        return c.json({
            shortUrl: `${new URL(c.req.url).origin}/${shortId}`,
            shortId
        }, 200, { ...corsHeaders });
    } catch (error: any) {
        console.error('Error creating short URL:', error);
        return c.json({ error: 'Failed to create short URL' }, 500, { ...corsHeaders });
    }
});




async function updateAnalytics(
    DB: any,
    shortId: string,
    visitorId: string,  
    city: string,
    country: string,
    userAgent: string
): Promise<void> {
    try {
        const { results } = await DB.prepare(`
            SELECT totalClicks, uniqueClicks, visitorDetails FROM urls WHERE shortId = ? LIMIT 1
        `).bind(shortId).all();

        const urlRecord = results?.[0] as { totalClicks: number; uniqueClicks: number; visitorDetails: string };

        if (urlRecord) {
            let visitorDetails: VisitorDetail[] = JSON.parse(urlRecord.visitorDetails || '[]');
            let totalClicks = urlRecord.totalClicks + 1;
            let uniqueClicks = urlRecord.uniqueClicks;

            
            const isUniqueVisitor = !visitorDetails.some(v => v.visitorId === visitorId);

            if (isUniqueVisitor) {
                uniqueClicks += 1;
                visitorDetails.push({
                    visitorId,
                    city,
                    country,
                    timestamp: new Date().toISOString(),
                    userAgent: userAgent.substring(0, 200)
                });
                if (visitorDetails.length > 1000) {
                    visitorDetails = visitorDetails.slice(-1000);
                }
            }

            await DB.prepare(`
                UPDATE urls
                SET totalClicks = ?, uniqueClicks = ?, visitorDetails = ?, updatedAt = ?
                WHERE shortId = ?
            `).bind(
                totalClicks,
                uniqueClicks,
                JSON.stringify(visitorDetails),
                new Date().toISOString(),
                shortId
            ).run();

            console.log(`Analytics: ${shortId} | Total: ${totalClicks} | Unique: ${uniqueClicks}`);
        }
    } catch (error) {
        console.error('Analytics update error:', error);
    }
}



app.post('/track', async (c) => {
    const { shortId, visitorId, city, additionalData } = await c.req.json<{
        shortId: string;
        visitorId: string;  
        city?: string;
        additionalData?: any;
    }>();

    if (!shortId || !visitorId) {
        return c.json({ error: 'shortId and visitorId required' }, 400, { ...corsHeaders });
    }

    try {
        const cf = (c.req.raw as any).cf as IncomingRequestCfProperties;
        const userAgent = c.req.header('User-Agent') || '';
        const country = cf?.country || 'Unknown';
        const detectedCity = city || cf?.city || 'Unknown';

        
        c.executionCtx?.waitUntil(
            updateAnalytics(c.env.DB, shortId, visitorId, detectedCity, country, userAgent)
        );

        return c.json({ success: true }, 200, { ...corsHeaders });
    } catch (error: any) {
        console.error('Error in tracking:', error);
        return c.json({ error: 'Tracking failed' }, 500, { ...corsHeaders });
    }
});




app.get('/analytics/:shortId', async (c) => {
    const shortId = c.req.param('shortId');

    try {
        const { results } = await c.env.DB.prepare(`
            SELECT totalClicks, uniqueClicks, visitorDetails, createdAt, updatedAt
            FROM urls WHERE shortId = ? LIMIT 1
        `).bind(shortId).all();

        const urlRecord = results?.[0];

        if (urlRecord) {
            const visitorDetails = JSON.parse(urlRecord.visitorDetails || '[]');

            return c.json({
                totalClicks: urlRecord.totalClicks,
                uniqueClicks: urlRecord.uniqueClicks,
                createdAt: urlRecord.createdAt,
                updatedAt: urlRecord.updatedAt,
                visitors: visitorDetails.slice(-100)
            }, 200, { ...corsHeaders });
        } else {
            return c.json({ message: 'Analytics not found' }, 404, { ...corsHeaders });
        }
    } catch (error: any) {
        console.error('Error fetching analytics:', error);
        return c.json({ error: 'Failed to fetch analytics' }, 500, { ...corsHeaders });
    }
});





// not used
app.post('/track-batch', async (c) => {
    const { events } = await c.req.json<{
        events: Array<{shortId: string, visitorId: string, city?: string}>
    }>();

    if (!events || !Array.isArray(events) || events.length === 0) {
        return c.json({ error: 'events array required' }, 400, { ...corsHeaders });
    }

    const limitedEvents = events.slice(0, 10);

    const cf = (c.req.raw as any).cf as IncomingRequestCfProperties;
    const userAgent = c.req.header('User-Agent') || '';
    const country = cf?.country || 'Unknown';

    c.executionCtx?.waitUntil(
        Promise.allSettled(
            limitedEvents.map(event =>
                updateAnalytics(
                    c.env.DB,
                    event.shortId,
                    event.visitorId,  
                    event.city || cf?.city || 'Unknown',
                    country,
                    userAgent
                )
            )
        )
    );

    return c.json({
        success: true,
        processed: limitedEvents.length
    }, 200, { ...corsHeaders });
});



app.get('/:shortId', async (c) => {
    const shortId = c.req.param('shortId');

    try {
        const { results } = await c.env.DB.prepare(`
            SELECT shortId, originalUrl FROM urls WHERE shortId = ? LIMIT 1
        `).bind(shortId).all();

        const urlRecord = results?.[0] as { shortId: string; originalUrl: string };

        if (urlRecord) {
            
            const redirectUrl = `https://redirecting-to-page.vercel.app/?s=${shortId}&u=${encodeURIComponent(urlRecord.originalUrl)}`;
            return Response.redirect(redirectUrl, 302);
        } else {
            return c.json({ message: 'URL not found' }, 404, { ...corsHeaders });
        }
    } catch (error: any) { 
        console.error('Error redirecting:', error);
        return c.json({ error: 'Failed to redirect' }, 500, { ...corsHeaders });
    }
});


function generateVisitorId(ip: string, userAgent: string): string {
    const combined = ip + userAgent + Date.now().toString();
    let hash = 0;
    for (let i = 0; i < combined.length; i++) {
        const char = combined.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return 'v_' + Math.abs(hash).toString(36) + '_' + Date.now().toString(36).slice(-4);
}
export default app;
