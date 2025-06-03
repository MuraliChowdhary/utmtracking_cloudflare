// import { Hono } from 'hono';
// import { nanoid } from 'nanoid';
// import { IncomingRequestCfProperties } from '@cloudflare/workers-types';

// // CORS headers
// const corsHeaders = {
//   'Access-Control-Allow-Origin': '*',
//   'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
//   'Access-Control-Allow-Headers': 'Content-Type',
// };

// interface Env {
//   DB: any;
// }

// interface UrlRecord {
//   id: number;
//   shortId: string;
//   originalUrl: string;
//   totalClicks: number;
//   uniqueClicks: number;
//   visitorDetails: string;
//   createdAt: string;
//   updatedAt: string;
// }

// interface VisitorDetail {
//   visitorId: string;
//   city: string;
//   country: string;
//   timestamp: string;
//   userAgent: string;
// }

// const app = new Hono<{ Bindings: Env }>();

// // Enhanced visitor ID generation with better collision resistance
// function generateVisitorId(ip: string, userAgent: string): string {
//   const combined = ip + userAgent + Date.now().toString();
//   let hash = 0;
//   for (let i = 0; i < combined.length; i++) {
//     const char = combined.charCodeAt(i);
//     hash = ((hash << 5) - hash) + char;
//     hash = hash & hash;
//   }
//   return 'v_' + Math.abs(hash).toString(36) + '_' + Date.now().toString(36).slice(-4);
// }

// // CORS Preflight request handler
// app.options('*', (c) => {
//   return new Response(null, {
//     headers: corsHeaders,
//   });
// });

// // Health check endpoint
// app.get('/health', (c) => {
//   return c.text('Server is running', 200, { ...corsHeaders });
// });

// // Route to create a short URL
// app.post('/shorten', async (c) => {
//   const { originalUrl } = await c.req.json<{ originalUrl: string }>();

//   if (!originalUrl) {
//     return c.json({ error: 'originalUrl is required' }, 400, { ...corsHeaders });
//   }

//   // Validate URL format
//   try {
//     new URL(originalUrl);
//   } catch {
//     return c.json({ error: 'Invalid URL format' }, 400, { ...corsHeaders });
//   }

//   const shortId = nanoid(8);
//   const now = new Date().toISOString();

//   try {
//     await c.env.DB.prepare(`
//       INSERT INTO urls (shortId, originalUrl, totalClicks, uniqueClicks, visitorDetails, createdAt, updatedAt)
//       VALUES (?, ?, ?, ?, ?, ?, ?)
//     `).bind(shortId, originalUrl, 0, 0, JSON.stringify([]), now, now).run();

//     return c.json({ 
//       shortUrl: `${new URL(c.req.url).origin}/${shortId}`,
//       shortId 
//     }, 200, { ...corsHeaders });
//   } catch (error: any) {
//     console.error('Error creating short URL:', error);
//     return c.json({ error: 'Failed to create short URL' }, 500, { ...corsHeaders });
//   }
// });

// // FAST redirect route - sends to Vercel frontend with minimal data
// app.get('/:shortId', async (c) => {
//   const shortId = c.req.param('shortId');

//   try {
//     // Single DB query with prepared statement for speed
//     const { results } = await c.env.DB.prepare(`
//       SELECT shortId, originalUrl FROM urls WHERE shortId = ? LIMIT 1
//     `).bind(shortId).all();

//     const urlRecord = results?.[0] as { shortId: string; originalUrl: string };

//     if (urlRecord) {
//       // Collect visitor info for background processing
//       const cf = (c.req.raw as any).cf as IncomingRequestCfProperties;
//       const ip = typeof cf?.ip === 'string' ? cf.ip : (c.req.header('CF-Connecting-IP') || 'unknown');
//       const userAgent = c.req.header('User-Agent') || '';
//       const city = cf?.city || 'Unknown';
//       const country = cf?.country || 'Unknown';
//       const visitorId = generateVisitorId(ip, userAgent);

//       // Background analytics (non-blocking, FREE with waitUntil)
//       c.executionCtx?.waitUntil(
//         updateAnalytics(c.env.DB, shortId, visitorId, city, country, userAgent)
//       );

//       // Redirect to Vercel frontend with minimal query params
//       const redirectUrl = `https://utmtrackingpage.vercel.app/?s=${shortId}&u=${encodeURIComponent(urlRecord.originalUrl)}`;
      
//       return Response.redirect(redirectUrl, 302);
//     } else {
//       return c.json({ message: 'URL not found' }, 404, { ...corsHeaders });
//     }
//   } catch (error: any) {
//     console.error('Error redirecting:', error);
//     return c.json({ error: 'Failed to redirect' }, 500, { ...corsHeaders });
//   }
// });

// // Background analytics processing - OPTIMIZED
// async function updateAnalytics(
//   DB: any, 
//   shortId: string, 
//   visitorId: string, 
//   city: string, 
//   country: string, 
//   userAgent: string
// ): Promise<void> {
//   try {
//     // Use transaction for consistency
//     const { results } = await DB.prepare(`
//       SELECT totalClicks, uniqueClicks, visitorDetails FROM urls WHERE shortId = ? LIMIT 1
//     `).bind(shortId).all();

//     const urlRecord = results?.[0] as { totalClicks: number; uniqueClicks: number; visitorDetails: string };

//     if (urlRecord) {
//       let visitorDetails: VisitorDetail[] = JSON.parse(urlRecord.visitorDetails || '[]');
//       let totalClicks = urlRecord.totalClicks + 1;
//       let uniqueClicks = urlRecord.uniqueClicks;

//       // Check for unique visitor (optimized)
//       const isUniqueVisitor = !visitorDetails.some(v => v.visitorId === visitorId);

//       if (isUniqueVisitor) {
//         uniqueClicks += 1;
        
//         // Add new visitor (keep only last 1000 for performance)
//         visitorDetails.push({
//           visitorId,
//           city,
//           country,
//           timestamp: new Date().toISOString(),
//           userAgent: userAgent.substring(0, 200) // Truncate for storage efficiency
//         });

//         // Keep only recent visitors to prevent bloat
//         if (visitorDetails.length > 1000) {
//           visitorDetails = visitorDetails.slice(-1000);
//         }
//       }

//       // Single UPDATE query
//       await DB.prepare(`
//         UPDATE urls
//         SET totalClicks = ?, uniqueClicks = ?, visitorDetails = ?, updatedAt = ?
//         WHERE shortId = ?
//       `).bind(
//         totalClicks, 
//         uniqueClicks, 
//         JSON.stringify(visitorDetails), 
//         new Date().toISOString(), 
//         shortId
//       ).run();

//       console.log(`Analytics: ${shortId} | Total: ${totalClicks} | Unique: ${uniqueClicks}`);
//     }
//   } catch (error) {
//     console.error('Analytics update error:', error);
//     // Don't throw - this is background processing
//   }
// }

// // Enhanced tracking endpoint for frontend
// app.post('/track', async (c) => {
//   const { shortId, visitorId, city, additionalData } = await c.req.json<{
//     shortId: string;
//     visitorId: string;
//     city?: string;
//     additionalData?: any;
//   }>();

//   if (!shortId || !visitorId) {
//     return c.json({ error: 'shortId and visitorId required' }, 400, { ...corsHeaders });
//   }

//   try {
//     const cf = (c.req.raw as any).cf as IncomingRequestCfProperties;
//     const userAgent = c.req.header('User-Agent') || '';
//     const country = cf?.country || 'Unknown';
//     const detectedCity = city || cf?.city || 'Unknown';

//     // Background processing
//     c.executionCtx?.waitUntil(
//       updateAnalytics(c.env.DB, shortId, visitorId, detectedCity, country, userAgent)
//     );

//     return c.json({ success: true }, 200, { ...corsHeaders });
//   } catch (error: any) {
//     console.error('Error in tracking:', error);
//     return c.json({ error: 'Tracking failed' }, 500, { ...corsHeaders });
//   }
// });

// // Analytics endpoint for dashboard
// app.get('/analytics/:shortId', async (c) => {
//   const shortId = c.req.param('shortId');

//   try {
//     const { results } = await c.env.DB.prepare(`
//       SELECT totalClicks, uniqueClicks, visitorDetails, createdAt, updatedAt 
//       FROM urls WHERE shortId = ? LIMIT 1
//     `).bind(shortId).all();

//     const urlRecord = results?.[0];

//     if (urlRecord) {
//       const visitorDetails = JSON.parse(urlRecord.visitorDetails || '[]');
      
//       return c.json({
//         totalClicks: urlRecord.totalClicks,
//         uniqueClicks: urlRecord.uniqueClicks,
//         createdAt: urlRecord.createdAt,
//         updatedAt: urlRecord.updatedAt,
//         visitors: visitorDetails.slice(-100) // Return last 100 visitors
//       }, 200, { ...corsHeaders });
//     } else {
//       return c.json({ message: 'Analytics not found' }, 404, { ...corsHeaders });
//     }
//   } catch (error: any) {
//     console.error('Error fetching analytics:', error);
//     return c.json({ error: 'Failed to fetch analytics' }, 500, { ...corsHeaders });
//   }
// });

// // Batch tracking for high-volume scenarios
// app.post('/track-batch', async (c) => {
//   const { events } = await c.req.json<{ 
//     events: Array<{shortId: string, visitorId: string, city?: string}> 
//   }>();

//   if (!events || !Array.isArray(events) || events.length === 0) {
//     return c.json({ error: 'events array required' }, 400, { ...corsHeaders });
//   }

//   // Process max 10 events per batch to prevent timeout
//   const limitedEvents = events.slice(0, 10);
  
//   const cf = (c.req.raw as any).cf as IncomingRequestCfProperties;
//   const userAgent = c.req.header('User-Agent') || '';
//   const country = cf?.country || 'Unknown';

//   // Background batch processing
//   c.executionCtx?.waitUntil(
//     Promise.allSettled(
//       limitedEvents.map(event =>
//         updateAnalytics(
//           c.env.DB, 
//           event.shortId, 
//           event.visitorId, 
//           event.city || cf?.city || 'Unknown',
//           country,
//           userAgent
//         )
//       )
//     )
//   );

//   return c.json({ 
//     success: true, 
//     processed: limitedEvents.length 
//   }, 200, { ...corsHeaders });
// });

// export default app;




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

// FAST redirect route - now only redirects to Vercel frontend, no analytics here
app.get('/:shortId', async (c) => {
    const shortId = c.req.param('shortId');

    try {
        const { results } = await c.env.DB.prepare(`
            SELECT shortId, originalUrl FROM urls WHERE shortId = ? LIMIT 1
        `).bind(shortId).all();

        const urlRecord = results?.[0] as { shortId: string; originalUrl: string };

        if (urlRecord) {
            // IMPORTANT CHANGE: Removed the direct call to updateAnalytics here.
            // Analytics will now be handled by the Vercel frontend's /track call.
            const redirectUrl = `https://utmtrackingpage.vercel.app/?s=${shortId}&u=${encodeURIComponent(urlRecord.originalUrl)}`;
            return Response.redirect(redirectUrl, 302);
        } else {
            return c.json({ message: 'URL not found' }, 404, { ...corsHeaders });
        }
    } catch (error: any) {
        console.error('Error redirecting:', error);
        return c.json({ error: 'Failed to redirect' }, 500, { ...corsHeaders });
    }
});

// Enhanced visitor ID generation (kept as a utility, but not primary for unique clicks)
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

// Background analytics processing - this is now the SOLE place for click updates
async function updateAnalytics(
    DB: any,
    shortId: string,
    visitorId: string, // This visitorId comes from the frontend (FingerprintJS)
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

            // Check for unique visitor based on the visitorId received from frontend
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

// Enhanced tracking endpoint for frontend - this is the primary entry for analytics
app.post('/track', async (c) => {
    const { shortId, visitorId, city, additionalData } = await c.req.json<{
        shortId: string;
        visitorId: string; // This is the visitorId from FingerprintJS on the frontend
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

        // Call updateAnalytics only from this endpoint
        c.executionCtx?.waitUntil(
            updateAnalytics(c.env.DB, shortId, visitorId, detectedCity, country, userAgent)
        );

        return c.json({ success: true }, 200, { ...corsHeaders });
    } catch (error: any) {
        console.error('Error in tracking:', error);
        return c.json({ error: 'Tracking failed' }, 500, { ...corsHeaders });
    }
});

// Analytics endpoint for dashboard
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

// Batch tracking for high-volume scenarios
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
                    event.visitorId, // Use the visitorId from the batch event
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

export default app;
