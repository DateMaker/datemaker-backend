// =====================================================
// DATEMAKER BACKEND SERVER WITH STRIPE + GOOGLE PLACES + TICKETMASTER
// ✨ WITH REDIS CACHING (80-90% cost savings!)
// 🛡️ WITH RATE LIMITING (prevents abuse!)
// =====================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const axios = require('axios');
const multer = require('multer');
const { createClient } = require('redis');
const rateLimit = require('express-rate-limit');
const appleIAPRoutes = require('./routes/appleIAP');

// =====================================================
// 🛡️ RATE LIMITING CONFIGURATION (NEW!)
// =====================================================

// General API rate limit - 100 requests per 15 minutes
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: {
    error: 'Too many requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Strict limit for expensive Places API - 60 requests per 24 hours
const placesLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  max: 60,
  message: {
    error: 'Daily date generation limit reached (60/day). Please try again tomorrow!',
    retryAfter: '24 hours',
    tip: 'Try using the "Refresh" button for new options instead of regenerating!'
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.log('🚫 RATE LIMIT HIT: User hit daily limit (60 dates). IP:', req.ip);
    res.status(429).json({
      error: 'Daily date generation limit reached (60/day). Please try again tomorrow!',
      retryAfter: '24 hours',
      tip: 'Try using the "Refresh" button for new options instead of regenerating!'
    });
  }
});

// Moderate limit for geocoding - 50 requests per 15 minutes
const geocodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: {
    error: 'Spam prevention. Date Generating will work again in a few minutes.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Lenient limit for photos - 100 requests per 15 minutes
const photoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    error: 'Too many photo requests. Please try again in a few minutes.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Very strict limit for Stripe checkout - 10 per 15 minutes
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: 'Too many checkout attempts. Please contact support if you need help.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// =====================================================
// 📸 PHOTO UPLOAD CONFIGURATION
// =====================================================

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// Rate limit for uploads - 20 per 15 minutes
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: {
    error: 'Too many uploads. Please try again in a few minutes.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// =====================================================
// 🔥 REDIS CACHE SETUP
// =====================================================

let redisClient;
let isRedisConnected = false;

async function initializeRedis() {
  try {
    redisClient = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) {
            console.log('❌ Redis max retries reached. Running without cache.');
            return new Error('Redis max retries exceeded');
          }
          return Math.min(retries * 50, 500);
        }
      }
    });

    redisClient.on('error', (err) => {
      console.error('❌ Redis Error:', err.message);
      isRedisConnected = false;
    });

    redisClient.on('ready', () => {
      console.log('✅ Redis cache READY! Cost optimization ACTIVE! 💰');
      isRedisConnected = true;
    });

    await redisClient.connect();
  } catch (error) {
    console.error('⚠️  Redis connection failed:', error.message);
    console.log('⚠️  App will run WITHOUT caching (higher API costs)');
    isRedisConnected = false;
  }
}

// Initialize Redis on startup
initializeRedis();

// =====================================================
// 💾 CACHE HELPER FUNCTIONS
// =====================================================

const CACHE_TTL = 24 * 60 * 60; // 24 hours in seconds

async function getCachedData(key) {
  if (!isRedisConnected) return null;
  
  try {
    const cached = await redisClient.get(key);
    if (cached) {
      console.log(`🎯 CACHE HIT: Saved $0.007! (${key.substring(0, 40)}...)`);
      return JSON.parse(cached);
    }
    console.log(`💸 CACHE MISS: Will cost $0.007 (${key.substring(0, 40)}...)`);
    return null;
  } catch (error) {
    console.error('Cache read error:', error.message);
    return null;
  }
}

async function setCachedData(key, data, ttl = CACHE_TTL) {
  if (!isRedisConnected) return;
  
  try {
    await redisClient.setEx(key, ttl, JSON.stringify(data));
    console.log(`💾 CACHED for 24h: Future requests FREE! (${key.substring(0, 40)}...)`);
  } catch (error) {
    console.error('Cache write error:', error.message);
  }
}

// =====================================================
// FIREBASE INITIALIZATION
// =====================================================

// Firebase Admin Setup
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  // Production: decode from base64 environment variable
  const serviceAccountJson = Buffer.from(
    process.env.FIREBASE_SERVICE_ACCOUNT_BASE64,
    'base64'
  ).toString('utf-8');
  serviceAccount = JSON.parse(serviceAccountJson);
} else {
  // Development: load from file
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});

const db = admin.firestore();
const app = express();
app.set('trust proxy', 1);

// =====================================================
// MIDDLEWARE
// =====================================================

// IMPORTANT: Raw body for Stripe webhook MUST come before express.json()
app.post('/api/webhook', 
  express.raw({type: 'application/json'}), 
  handleStripeWebhook
);

// Standard middleware for all other routes

// CORS Configuration
app.use(cors({
  origin: [
    'https://datemaker-frontend.vercel.app',
    'https://datemaker-frontend-git-main-datemakers-projects.vercel.app',
    'https://datemaker-frontend-fezowva4r-datemakers-projects.vercel.app',
    'https://thedatemakerapp.com',        
    'https://www.thedatemakerapp.com',    
    'http://localhost:3000',
    'capacitor://localhost',           // ✅ For iOS app
    'ionic://localhost',               // ✅ For Android app (future)
    'http://localhost',                // ✅ Additional fallback
    'http://192.168.68.102:3001'      // ✅ Your local IP
  ],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));

// 🛡️ Apply general rate limiting to all routes
app.use('/api/', generalLimiter);

app.use('/api', appleIAPRoutes);

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// =====================================================
// WEB CHECKOUT (External Payment - No Apple Fee!)
// =====================================================

app.post('/api/create-web-checkout', checkoutLimiter, async (req, res) => {
  try {
    const { plan, userId, email } = req.body;
    
    // Verify Firebase token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const token = authHeader.split('Bearer ')[1];
    await admin.auth().verifyIdToken(token);

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const priceId = plan === 'yearly' 
      ? process.env.STRIPE_ANNUAL_PRICE_ID 
      : process.env.STRIPE_MONTHLY_PRICE_ID;

    if (!priceId) {
      return res.status(500).json({ error: 'Price ID not configured for plan: ' + plan });
    }

    const session = await stripe.checkout.sessions.create({
      customer_email: email,
      client_reference_id: userId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price: priceId,
        quantity: 1,
      }],
      subscription_data: {
        trial_period_days: 7,
        metadata: { userId, plan, source: 'web' }
      },
      metadata: { userId, plan, source: 'web' },
    success_url: `https://datemaker-backend-1.onrender.com/api/redirect-to-app?session_id={CHECKOUT_SESSION_ID}&user_id=${userId}`,
     cancel_url: `https://www.thedatemakerapp.com/#/subscribe?canceled=true`,
    });

    console.log(`✅ Web checkout created for ${userId}: ${session.id}`);
    res.json({ url: session.url, sessionId: session.id });

  } catch (error) {
    console.error('Web checkout error:', error);
    res.status(500).json({ error: 'Failed to create checkout', message: error.message });
  }
});

// =====================================================
// REDIRECT TO APP AFTER PAYMENT (Bypasses Vercel)
// =====================================================

app.get('/api/redirect-to-app', (req, res) => {
  const userId = req.query.user_id || '';
  const sessionId = req.query.session_id || '';
  
  console.log(`🔄 Redirecting user ${userId} to app via deep link`);
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Payment Successful!</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          margin: 0;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        }
        .container {
          background: white;
          padding: 3rem;
          border-radius: 24px;
          text-align: center;
          max-width: 400px;
          margin: 1rem;
          box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        }
        h1 { color: #111; margin-bottom: 0.5rem; }
        p { color: #666; margin-bottom: 1.5rem; }
        .btn {
          display: inline-block;
          padding: 1rem 2rem;
          background: linear-gradient(to right, #ec4899, #a855f7);
          color: white;
          text-decoration: none;
          border-radius: 12px;
          font-weight: 600;
          font-size: 1.1rem;
          border: none;
          cursor: pointer;
        }
        .btn:active {
          transform: scale(0.98);
          opacity: 0.9;
        }
        .success-check {
          color: #10b981;
          font-weight: 600;
          margin-bottom: 1.5rem;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div style="font-size: 4rem; margin-bottom: 1rem;">🎉</div>
        <h1>Payment Successful!</h1>
        <p>Your 7-day free trial has started.</p>
        <p class="success-check">✓ Your account has been upgraded</p>
        <button class="btn" onclick="closePage()">Close Page</button>
        <p style="font-size: 0.8rem; color: #999; margin-top: 1.5rem;">
          Tap the X in the top-left if the button doesn't work
        </p>
      </div>
      <script>
        function closePage() {
          // For Capacitor in-app browser, posting a message or navigating can trigger close
          if (window.webkit && window.webkit.messageHandlers) {
            // Try to trigger Capacitor's close
            try {
              window.webkit.messageHandlers.bridge.postMessage({ type: 'close' });
            } catch(e) {}
          }
          
          // Standard close attempts
          window.close();
          
          // Fallback - navigate to blank (some browsers close on this)
          setTimeout(function() {
            window.location.href = 'about:blank';
          }, 100);
        }
      </script>
    </body>
    </html>
  `);
});

// =====================================================
// GEOCODING API (Convert address to coordinates)
// 🔥 WITH CACHING! 🛡️ WITH RATE LIMITING!
// =====================================================

app.get('/api/geocode', geocodeLimiter, async (req, res) => {
  try {
    const { address } = req.query;

    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    // 🎯 CHECK CACHE FIRST
    const cacheKey = `geocode:${address.toLowerCase()}`;
    const cachedResult = await getCachedData(cacheKey);
    
    if (cachedResult) {
      return res.json(cachedResult);
    }

    // 🌐 FETCH FROM GOOGLE API
    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/geocode/json',
      {
        params: {
          address: address,
          key: process.env.GOOGLE_MAPS_API_KEY
        }
      }
    );

    // 💾 CACHE FOR 30 DAYS (addresses don't change)
    await setCachedData(cacheKey, response.data, 30 * 24 * 60 * 60);

    res.json(response.data);
  } catch (error) {
    console.error('Error geocoding address:', error.message);
    res.status(500).json({ 
      error: 'Failed to geocode address',
      message: error.message 
    });
  }
});

// =====================================================
// MAIN PLACES SEARCH (Used by frontend)
// 🔥 WITH CACHING! 🛡️ WITH STRICT RATE LIMITING!
// =====================================================

app.get('/api/places', placesLimiter, async (req, res) => {
  const startTime = Date.now();
  try {
    const { lat, lng, radius, keyword, includeEvents, dateRange, selectedDate, refresh } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: 'Latitude and longitude are required' });
    }

    // 🎯 CREATE CACHE KEY
    // If refresh=true, skip cache by adding timestamp
    const cacheKey = refresh === 'true' 
      ? `places:${lat}:${lng}:${radius}:${keyword}:${Date.now()}`
      : `places:${lat}:${lng}:${radius}:${keyword}:${includeEvents}:${dateRange}:${selectedDate}`;

    console.log(`\n🔍 Searching places: ${keyword} near (${lat}, ${lng})`);
    console.log(`🔄 Refresh mode: ${refresh === 'true' ? 'YES (forcing new data)' : 'NO (cache allowed)'}`);

    // 💾 CHECK CACHE FIRST (skip if refresh=true)
    if (refresh !== 'true') {
      const cachedResults = await getCachedData(cacheKey);
      if (cachedResults) {
        const responseTime = Date.now() - startTime;
        console.log(`⚡ Served from CACHE in ${responseTime}ms (saved ~$0.028!)`);
        return res.json(cachedResults);
      }
    }

    // 🌐 FETCH FROM GOOGLE MAPS API (your existing logic)
    let allResults = [];
    const seenPlaceIds = new Set();

    if (keyword) {
      // Split keywords and search for each one
      const keywords = keyword.split(' ').filter(k => k.length > 2);
      
      console.log(`📍 Searching ${keywords.length} keywords individually...`);
      
      for (const kw of keywords) {
        try {
          const placesParams = {
            location: `${lat},${lng}`,
            radius: radius || 10000,
            keyword: kw,
            key: process.env.GOOGLE_MAPS_API_KEY
          };

          const response = await axios.get(
            'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
            { params: placesParams }
          );

          if (response.data.results) {
            const newPlaces = response.data.results.filter(place => {
              if (seenPlaceIds.has(place.place_id)) return false;
              seenPlaceIds.add(place.place_id);
              return true;
            });
            
            allResults.push(...newPlaces);
            console.log(`  ✅ "${kw}": found ${newPlaces.length} new places`);
          }
        } catch (error) {
          console.error(`  ❌ Error searching "${kw}":`, error.message);
        }
      }
    } else {
      // No keyword - do a general search
      const placesParams = {
        location: `${lat},${lng}`,
        radius: radius || 10000,
        key: process.env.GOOGLE_MAPS_API_KEY
      };

      const response = await axios.get(
        'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
        { params: placesParams }
      );

      allResults = response.data.results || [];
    }

    let results = allResults;
    console.log(`✅ Total unique places found: ${results.length}`);

    // If includeEvents is true, fetch Ticketmaster events
    if (includeEvents === 'true') {
      try {
        // 🎯 CHECK EVENTS CACHE FIRST
        const eventsCacheKey = `events:${lat}:${lng}:${dateRange}:${selectedDate}`;
        let events = await getCachedData(eventsCacheKey);

        if (!events) {
          // Fetch from Ticketmaster
          const eventParams = {
            apikey: process.env.TICKETMASTER_API_KEY,
            latlong: `${lat},${lng}`,
            radius: 25,
            unit: 'miles',
            size: 20,
            sort: 'date,asc'
          };

          if (keyword) eventParams.keyword = keyword;

          // Add date filtering
          if (dateRange === 'today') {
            const today = new Date().toISOString().split('T')[0];
            eventParams.startDateTime = `${today}T00:00:00Z`;
            eventParams.endDateTime = `${today}T23:59:59Z`;
          } else if (dateRange === 'thisweek') {
            const today = new Date();
            const endOfWeek = new Date(today);
            endOfWeek.setDate(today.getDate() + 7);
            eventParams.startDateTime = today.toISOString();
            eventParams.endDateTime = endOfWeek.toISOString();
          } else if (dateRange === 'thismonth') {
            const today = new Date();
            const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0);
            eventParams.startDateTime = today.toISOString();
            eventParams.endDateTime = endOfMonth.toISOString();
          } else if (dateRange === 'custom' && selectedDate) {
            eventParams.startDateTime = `${selectedDate}T00:00:00Z`;
            eventParams.endDateTime = `${selectedDate}T23:59:59Z`;
          }

          const eventsResponse = await axios.get(
            'https://app.ticketmaster.com/discovery/v2/events.json',
            { params: eventParams }
          );

          if (eventsResponse.data._embedded?.events) {
            events = eventsResponse.data._embedded.events.map(event => ({
              place_id: `ticketmaster_${event.id}`,
              name: event.name,
              vicinity: event._embedded?.venues?.[0]?.address?.line1 || event._embedded?.venues?.[0]?.name || '',
              geometry: {
                location: {
                  lat: parseFloat(event._embedded?.venues?.[0]?.location?.latitude || lat),
                  lng: parseFloat(event._embedded?.venues?.[0]?.location?.longitude || lng)
                }
              },
              rating: null,
              photos: event.images?.[0] ? [{
                photo_reference: event.images[0].url,
                isDirectUrl: true
              }] : [],
              types: ['event'],
              isEvent: true,
              eventDate: event.dates?.start?.localDate,
              eventTime: event.dates?.start?.localTime,
              priceRange: event.priceRanges?.[0] ? `$${event.priceRanges[0].min}-$${event.priceRanges[0].max}` : null,
              website: event.url,
              venueName: event._embedded?.venues?.[0]?.name
            }));

            // 💾 CACHE EVENTS FOR 6 HOURS
            await setCachedData(eventsCacheKey, events, 6 * 60 * 60);
            console.log(`🎉 Added ${events.length} events from Ticketmaster`);
          } else {
            events = [];
          }
        } else {
          console.log(`⚡ Got ${events.length} events from CACHE`);
        }

        results = [...results, ...events];
      } catch (eventError) {
        console.error('Error fetching events:', eventError.message);
        // Continue without events if Ticketmaster fails
      }
    }

    const finalResults = { results };

    // 💾 CACHE RESULTS FOR 24 HOURS
    await setCachedData(cacheKey, finalResults, CACHE_TTL);

    const responseTime = Date.now() - startTime;
    const keywords = keyword ? keyword.split(' ').filter(k => k.length > 2) : [];
    const estimatedCost = keywords.length > 0 ? keywords.length * 0.007 : 0.007;
    console.log(`💰 Fetched from APIs in ${responseTime}ms (cost: ~$${estimatedCost.toFixed(3)})`);
    console.log(`💾 Results cached for 24 hours - future requests FREE!`);

    res.json(finalResults);
  } catch (error) {
    console.error('Error in places search:', error.message);
    res.status(500).json({ 
      error: 'Failed to search places',
      message: error.message 
    });
  }
});

// =====================================================
// PHOTO PROXY (For loading Google Photos without CORS)
// 🔥 WITH CACHING! 🛡️ WITH RATE LIMITING!
// =====================================================

app.get('/api/photo', photoLimiter, async (req, res) => {
  try {
    const { photoreference } = req.query;

    if (!photoreference) {
      return res.status(400).json({ error: 'Photo reference is required' });
    }

    // 🎯 CHECK CACHE FOR PHOTO URL
    const cacheKey = `photo:${photoreference}`;
    const cachedPhoto = await getCachedData(cacheKey);
    
    if (cachedPhoto && cachedPhoto.url) {
      console.log(`⚡ Photo URL from CACHE`);
      const photoUrl = cachedPhoto.url;
      
      // Fetch and stream the image
      const response = await axios({
        method: 'get',
        url: photoUrl,
        responseType: 'stream'
      });

      res.setHeader('Content-Type', response.headers['content-type']);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      response.data.pipe(res);
      return;
    }

    // 🌐 FETCH FROM GOOGLE API
    const photoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=800&photoreference=${photoreference}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    
    // 💾 CACHE PHOTO URL FOR 7 DAYS
    await setCachedData(cacheKey, { url: photoUrl }, 7 * 24 * 60 * 60);
    
    // Fetch the image and stream it through our server
    const response = await axios({
      method: 'get',
      url: photoUrl,
      responseType: 'stream'
    });

    // Set proper headers
    res.setHeader('Content-Type', response.headers['content-type']);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    
    // Pipe the image data to the response
    response.data.pipe(res);
  } catch (error) {
    console.error('Error fetching photo:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch photo',
      message: error.message 
    });
  }
});

// =====================================================
// 📸 PHOTO UPLOAD (For iOS/Mobile scrapbook photos)
// Supports both multipart form data AND base64 JSON
// =====================================================

app.post('/api/upload-photo', uploadLimiter, async (req, res) => {
  try {
    // Verify auth token first
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(token);
    const userId = decodedToken.uid;

    console.log(`📸 Upload request from user ${userId}`);

    let fileBuffer, fileName, mimeType;

    // Check if it's a base64 JSON upload (iOS) or multipart form (web)
    if (req.body.photo && typeof req.body.photo === 'string') {
      // BASE64 JSON UPLOAD (iOS)
      console.log('📱 Processing base64 upload (iOS)');
      
      const base64Data = req.body.photo;
      const matches = base64Data.match(/^data:(.+);base64,(.+)$/);
      
      if (!matches) {
        return res.status(400).json({ error: 'Invalid base64 format' });
      }
      
      mimeType = matches[1];
      fileBuffer = Buffer.from(matches[2], 'base64');
      fileName = req.body.fileName || `photo_${Date.now()}.jpg`;
      
      console.log(`📸 Base64 decoded: ${fileBuffer.length} bytes, type: ${mimeType}`);
    } else {
      // MULTIPART FORM UPLOAD (web) - use multer middleware
      return upload.single('photo')(req, res, async (err) => {
        if (err) {
          console.error('Multer error:', err);
          return res.status(400).json({ error: 'File upload error' });
        }
        
        if (!req.file) {
          return res.status(400).json({ error: 'No file provided' });
        }

        console.log('🌐 Processing multipart upload (web)');
        
        const bucket = admin.storage().bucket();
        const storedFileName = `dateMemories/${userId}/${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9.]/g, '_')}`;
        const file = bucket.file(storedFileName);

        await file.save(req.file.buffer, {
          metadata: { contentType: req.file.mimetype }
        });

        await file.makePublic();
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storedFileName}`;

        console.log(`✅ Photo uploaded: ${storedFileName}`);
        return res.json({ success: true, url: publicUrl });
      });
    }

    // Process base64 upload
    const bucket = admin.storage().bucket();
    const storedFileName = `dateMemories/${userId}/${Date.now()}_${fileName.replace(/[^a-zA-Z0-9.]/g, '_')}`;
    const file = bucket.file(storedFileName);

    await file.save(fileBuffer, {
      metadata: { contentType: mimeType }
    });

    await file.makePublic();
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${storedFileName}`;

    console.log(`✅ Photo uploaded: ${storedFileName}`);
    res.json({ success: true, url: publicUrl });

  } catch (error) {
    console.error('❌ Upload error:', error);
    res.status(500).json({ error: 'Upload failed', message: error.message });
  }
});

// =====================================================
// GOOGLE PLACES API PROXY (Keeping existing endpoints)
// =====================================================

app.post('/api/places/nearby', async (req, res) => {
  try {
    const { location, radius, type, keyword } = req.body;

    if (!location || !location.lat || !location.lng) {
      return res.status(400).json({ error: 'Location with lat/lng is required' });
    }

    const params = {
      location: `${location.lat},${location.lng}`,
      radius: radius || 5000,
      key: process.env.GOOGLE_MAPS_API_KEY
    };

    if (type) params.type = type;
    if (keyword) params.keyword = keyword;

    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/nearbysearch/json',
      { params }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching places:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch places',
      message: error.message 
    });
  }
});

app.post('/api/places/details', async (req, res) => {
  try {
    const { placeId } = req.body;

    if (!placeId) {
      return res.status(400).json({ error: 'Place ID is required' });
    }

    const response = await axios.get(
      'https://maps.googleapis.com/maps/api/place/details/json',
      {
        params: {
          place_id: placeId,
          fields: 'name,rating,formatted_phone_number,opening_hours,website,photos,price_level,reviews,formatted_address,geometry',
          key: process.env.GOOGLE_MAPS_API_KEY
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching place details:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch place details',
      message: error.message 
    });
  }
});

app.get('/api/places/photo', async (req, res) => {
  try {
    const { photoReference, maxWidth } = req.query;

    if (!photoReference) {
      return res.status(400).json({ error: 'Photo reference is required' });
    }

    const photoUrl = `https://maps.googleapis.com/maps/api/place/photo?maxwidth=${maxWidth || 400}&photoreference=${photoReference}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    
    res.redirect(photoUrl);
  } catch (error) {
    console.error('Error fetching photo:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch photo',
      message: error.message 
    });
  }
});

// =====================================================
// TICKETMASTER API PROXY
// =====================================================

app.post('/api/ticketmaster', async (req, res) => {
  try {
    const { location, radius, keyword, startDateTime, endDateTime } = req.body;

    if (!location || !location.lat || !location.lng) {
      return res.status(400).json({ error: 'Location with lat/lng is required' });
    }

    const params = {
      apikey: process.env.TICKETMASTER_API_KEY,
      latlong: `${location.lat},${location.lng}`,
      radius: radius || 25,
      unit: 'miles',
      size: 20,
      sort: 'date,asc'
    };

    if (keyword) params.keyword = keyword;
    if (startDateTime) params.startDateTime = startDateTime;
    if (endDateTime) params.endDateTime = endDateTime;

    const response = await axios.get(
      'https://app.ticketmaster.com/discovery/v2/events.json',
      { params }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching Ticketmaster events:', error.message);
    res.status(500).json({ 
      error: 'Failed to fetch events',
      message: error.message 
    });
  }
});

// =====================================================
// STRIPE WEBHOOKS (NO RATE LIMITING - Must receive all)
// =====================================================

async function handleStripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    console.log(`✅ Webhook received: ${event.type}`);
  } catch (err) {
    console.error(`❌ Webhook signature verification failed: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;
      
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
      
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    console.error(`Error processing webhook ${event.type}:`, error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
}

// =====================================================
// WEBHOOK HANDLERS
// =====================================================

async function handleCheckoutCompleted(session) {
  console.log('💳 Checkout completed:', session.id);
  
  const userId = session.client_reference_id;
  if (!userId) {
    console.error('No userId in checkout session');
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(session.subscription);
  
  // ✅ DETERMINE STATUS CORRECTLY
  const status = subscription.status === 'trialing' ? 'trial' : 'premium';
  
  const updateData = {
    stripeCustomerId: session.customer,
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: status,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

// Only add trialEndsAt if it exists and is valid
if (subscription.trial_end && !isNaN(subscription.trial_end)) {
  updateData.trialEndsAt = new Date(subscription.trial_end * 1000).toISOString();
}

// Only add currentPeriodEnd if it exists and is valid
if (subscription.current_period_end && !isNaN(subscription.current_period_end)) {
  updateData.currentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();
}

await db.collection('users').doc(userId).update(updateData);

  console.log(`✅ User ${userId} updated with trial subscription`);
}

async function handleSubscriptionCreated(subscription) {
  console.log('🎉 Subscription created:', subscription.id);
  
  const customer = subscription.customer;
  const userSnapshot = await db.collection('users')
    .where('stripeCustomerId', '==', customer)
    .limit(1)
    .get();

  if (userSnapshot.empty) {
    console.error('No user found for customer:', customer);
    return;
  }

  const userId = userSnapshot.docs[0].id;
  const status = subscription.status === 'trialing' ? 'trial' : 'premium';
  
  await db.collection('users').doc(userId).update({
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: status,
    trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null,
    currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log(`✅ User ${userId} subscription created with status: ${status}`);
}

async function handleSubscriptionUpdated(subscription) {
  console.log('🔄 Subscription updated:', subscription.id);
  
  const customer = subscription.customer;
  const userSnapshot = await db.collection('users')
    .where('stripeCustomerId', '==', customer)
    .limit(1)
    .get();

  if (userSnapshot.empty) {
    console.error('No user found for customer:', customer);
    return;
  }

  const userId = userSnapshot.docs[0].id;
  let status = 'free';

  if (subscription.status === 'active') {
    status = 'premium';
  } else if (subscription.status === 'trialing') {
    status = 'trial';
  } else if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired') {
    status = 'free';
  }

  const updateData = {
    subscriptionStatus: status,
    currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  if (subscription.cancel_at_period_end) {
    updateData.subscriptionWillCancelAt = new Date(subscription.current_period_end * 1000).toISOString();
  } else {
    updateData.subscriptionWillCancelAt = admin.firestore.FieldValue.delete();
  }

  await db.collection('users').doc(userId).update(updateData);

  console.log(`✅ User ${userId} subscription updated to: ${status}`);
}

async function handleSubscriptionDeleted(subscription) {
  console.log('❌ Subscription deleted:', subscription.id);
  
  const customer = subscription.customer;
  const userSnapshot = await db.collection('users')
    .where('stripeCustomerId', '==', customer)
    .limit(1)
    .get();

  if (userSnapshot.empty) {
    console.error('No user found for customer:', customer);
    return;
  }

  const userId = userSnapshot.docs[0].id;
  
  await db.collection('users').doc(userId).update({
    subscriptionStatus: 'free',
    stripeSubscriptionId: admin.firestore.FieldValue.delete(),
    subscriptionWillCancelAt: admin.firestore.FieldValue.delete(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log(`✅ User ${userId} subscription cancelled - reverted to free`);
}

async function handlePaymentSucceeded(invoice) {
  console.log('💰 Payment succeeded for invoice:', invoice.id);
  
  if (!invoice.subscription) {
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
  const customer = subscription.customer;
  
  const userSnapshot = await db.collection('users')
    .where('stripeCustomerId', '==', customer)
    .limit(1)
    .get();

  if (userSnapshot.empty) {
    console.error('No user found for customer:', customer);
    return;
  }

  const userId = userSnapshot.docs[0].id;
  
  await db.collection('users').doc(userId).update({
    subscriptionStatus: 'premium',
    currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log(`✅ User ${userId} payment succeeded - upgraded to premium`);
}

async function handlePaymentFailed(invoice) {
  console.log('💥 Payment failed for invoice:', invoice.id);
  
  if (!invoice.subscription) {
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
  const customer = subscription.customer;
  
  const userSnapshot = await db.collection('users')
    .where('stripeCustomerId', '==', customer)
    .limit(1)
    .get();

  if (userSnapshot.empty) {
    console.error('No user found for customer:', customer);
    return;
  }

  const userId = userSnapshot.docs[0].id;
  
  await db.collection('users').doc(userId).update({
    paymentFailed: true,
    paymentFailedAt: new Date().toISOString(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  console.log(`⚠️ User ${userId} payment failed - flagged for follow-up`);
}

// =====================================================
// STRIPE CHECKOUT & SUBSCRIPTION MANAGEMENT
// 🛡️ WITH RATE LIMITING!
// =====================================================

app.post('/api/create-checkout-session', checkoutLimiter, async (req, res) => {
  try {
    const { userId, plan = 'monthly', email, platform } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // Get user data
    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    // Check if user already has an active subscription
    if (userData?.stripeSubscriptionId) {
      return res.status(400).json({ 
        error: 'User already has an active subscription' 
      });
    }

    const priceId = plan === 'annual' 
      ? process.env.STRIPE_ANNUAL_PRICE_ID 
      : process.env.STRIPE_MONTHLY_PRICE_ID;

    if (!priceId) {
      return res.status(500).json({ 
        error: 'Price ID not configured for plan: ' + plan 
      });
    }

    // Determine redirect URLs based on platform
    let successUrl, cancelUrl;
    
    if (platform === 'ios') {
      // iOS app - use custom URL scheme
      successUrl = 'datemaker://checkout-success';
      cancelUrl = 'datemaker://checkout-cancelled';
      console.log('📱 iOS checkout - using deep links');
    } else {
      // Web - use normal URLs
      successUrl = `${process.env.FRONTEND_URL}?checkout=success`;
      cancelUrl = `${process.env.FRONTEND_URL}?checkout=cancelled`;
      console.log('🌐 Web checkout - using web URLs');
    }

    const session = await stripe.checkout.sessions.create({
      customer_email: email || userData?.email,
      client_reference_id: userId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price: priceId,
        quantity: 1,
      }],
      subscription_data: {
        trial_period_days: 7,
        metadata: {
          userId: userId,
          plan: plan
        }
      },
      metadata: {
        userId: userId,
        plan: plan
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    console.log(`✅ Checkout session created for user ${userId}: ${session.id}`);

    res.json({ 
      sessionId: session.id,
      url: session.url 
    });

  } catch (error) {
    console.error('Error creating checkout session:', error);
    res.status(500).json({ 
      error: 'Failed to create checkout session',
      message: error.message 
    });
  }
});

app.post('/api/create-portal-session', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    if (!userData?.stripeCustomerId) {
      return res.status(400).json({ 
        error: 'No Stripe customer found for this user' 
      });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: userData.stripeCustomerId,
      return_url: process.env.FRONTEND_URL,
    });

    console.log(`✅ Portal session created for user ${userId}`);

    res.json({ url: session.url });

  } catch (error) {
    console.error('❌ Error creating portal session:', error);
    res.status(500).json({ 
      error: 'Failed to create portal session',
      message: error.message,
      details: error.type || 'unknown_error'
    });
  }
});

// ⭐⭐⭐ CANCEL SUBSCRIPTION ENDPOINT ⭐⭐⭐
app.post('/api/cancel-subscription', async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const userDoc = await db.collection('users').doc(userId).get();
    const userData = userDoc.data();

    if (!userData.stripeSubscriptionId) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    // First, get the current subscription status
    const currentSubscription = await stripe.subscriptions.retrieve(userData.stripeSubscriptionId);

    // Check if already scheduled to cancel
    if (currentSubscription.cancel_at_period_end) {
      const cancelDate = currentSubscription.current_period_end 
        ? new Date(currentSubscription.current_period_end * 1000).toLocaleDateString()
        : 'end of billing period';
      
      return res.status(400).json({ 
        error: 'Subscription is already scheduled to cancel',
        message: `Your subscription will automatically cancel on ${cancelDate}`,
        cancelAt: currentSubscription.current_period_end 
          ? new Date(currentSubscription.current_period_end * 1000).toISOString()
          : null
      });
    }

    // If not already canceling, proceed with cancellation
    const subscription = await stripe.subscriptions.update(userData.stripeSubscriptionId, {
      cancel_at_period_end: true
    });

    const cancelAtDate = subscription.current_period_end 
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null;

    if (cancelAtDate) {
      await db.collection('users').doc(userId).update({
        subscriptionWillCancelAt: cancelAtDate,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    console.log(`🔕 Subscription will cancel at period end: ${userId}`);

    res.json({ 
      success: true, 
      message: 'Subscription will cancel at period end',
      cancelAt: cancelAtDate
    });

  } catch (error) {
    console.error('❌ Error cancelling subscription:', error);
    res.status(500).json({ 
      error: 'Failed to cancel subscription',
      message: error.message,
      details: error.type || 'unknown_error'
    });
  }
});

// =====================================================
// HEALTH CHECK
// =====================================================

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    timestamp: new Date().toISOString(),
    stripe: !!process.env.STRIPE_SECRET_KEY,
    firebase: !!admin.apps.length,
    googleMaps: !!process.env.GOOGLE_MAPS_API_KEY,
    ticketmaster: !!process.env.TICKETMASTER_API_KEY,
    redis: isRedisConnected,
    caching: isRedisConnected ? 'ACTIVE - 80-90% cost savings!' : 'DISABLED - higher API costs',
    rateLimiting: 'ACTIVE - preventing abuse!'
  });
});

// =====================================================
// ERROR HANDLING
// =====================================================

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// =====================================================
// SERVER START
// =====================================================

const PORT = process.env.PORT || 3001;

const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║   🚀 DateMaker Backend Server Started     ║
╟────────────────────────────────────────────╢
║   Port: ${PORT}                            
║   Environment: ${process.env.NODE_ENV || 'development'}
║   💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? '✅ Connected' : '❌ Not configured'}
║   🔥 Firebase: ${admin.apps.length ? '✅ Connected' : '❌ Not configured'}
║   🗺️  Google Maps: ${process.env.GOOGLE_MAPS_API_KEY ? '✅ Connected' : '❌ Not configured'}
║   🎫 Ticketmaster: ${process.env.TICKETMASTER_API_KEY ? '✅ Connected' : '❌ Not configured'}
║   💾 Redis Cache: ${isRedisConnected ? '✅ ACTIVE (80-90% savings!)' : '⚠️  DISABLED'}
║   🛡️  Rate Limiting: ✅ ACTIVE (abuse prevention!)
║   🔔 Webhook: /api/webhook
╚════════════════════════════════════════════╝

🛡️  RATE LIMITS ACTIVE:
   → General API: 100 req/15min
   → Places Search: 60 req/24hrs (daily limit)
   → Geocoding: 50 req/15min
   → Photos: 100 req/15min
   → Checkout: 10 req/15min
  `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  if (redisClient && isRedisConnected) {
    await redisClient.quit();
    console.log('Redis connection closed');
  }
  server.close(() => {
    console.log('HTTP server closed');
  });
});

module.exports = app;