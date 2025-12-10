const express = require('express');
const router = express.Router();
const admin = require('firebase-admin');
const axios = require('axios');

// Validate Apple receipt with Apple's servers
async function verifyReceiptWithApple(receipt, isProduction = true) {
  try {
    const endpoint = isProduction 
      ? 'https://buy.itunes.apple.com/verifyReceipt'
      : 'https://sandbox.itunes.apple.com/verifyReceipt';
    
    const response = await axios.post(endpoint, {
      'receipt-data': receipt,
      'password': process.env.APPLE_SHARED_SECRET || '', // Will add after approval
      'exclude-old-transactions': true
    });
    
    const data = response.data;
    
    // Status 21007 means receipt is from sandbox, retry with sandbox endpoint
    if (data.status === 21007 && isProduction) {
      return verifyReceiptWithApple(receipt, false);
    }
    
    return data;
  } catch (error) {
    console.error('❌ Apple receipt verification error:', error);
    return null;
  }
}

// Validate Apple receipt and upgrade user
router.post('/validate-apple-receipt', async (req, res) => {
  try {
    const { receipt, userId, productId, transactionId } = req.body;

    if (!receipt || !userId) {
      return res.status(400).json({ error: 'Missing receipt or userId' });
    }

    console.log(`📱 Apple IAP purchase for user ${userId}, product: ${productId}`);

    // Verify receipt with Apple (if Shared Secret is available)
    let verificationResult = null;
    
    if (process.env.APPLE_SHARED_SECRET) {
      verificationResult = await verifyReceiptWithApple(receipt);
      
      if (!verificationResult || verificationResult.status !== 0) {
        console.error('❌ Apple receipt verification failed:', verificationResult?.status);
        return res.status(400).json({ 
          error: 'Receipt verification failed',
          status: verificationResult?.status 
        });
      }
      
      console.log('✅ Apple receipt verified');
    } else {
      console.log('⚠️ No Shared Secret - trusting client (will add validation after approval)');
    }
    
    // Check if transaction already processed (prevent duplicate upgrades)
    if (transactionId) {
      const existingTransaction = await admin.firestore()
        .collection('appleTransactions')
        .doc(transactionId)
        .get();
      
      if (existingTransaction.exists) {
        console.log('⚠️ Transaction already processed:', transactionId);
        return res.json({ 
          success: true, 
          message: 'Transaction already processed',
          alreadyProcessed: true 
        });
      }
      
      // Store transaction to prevent duplicates
      await admin.firestore()
        .collection('appleTransactions')
        .doc(transactionId)
        .set({
          userId: userId,
          productId: productId,
          processedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }
    
    // Determine subscription type and expiry
    const isYearly = productId.includes('yearly');
    const subscriptionType = isYearly ? 'yearly' : 'monthly';
    
    // Calculate expiry date (Apple handles actual renewal)
    const expiryDate = new Date();
    expiryDate.setMonth(expiryDate.getMonth() + (isYearly ? 12 : 1));
    
    // Update user in Firebase
    await admin.firestore().collection('users').doc(userId).update({
      isPremium: true,
      subscriptionType: subscriptionType,
      subscriptionPlatform: 'apple',
      appleSubscriptionDate: admin.firestore.FieldValue.serverTimestamp(),
      appleProductId: productId,
      appleSubscriptionExpiry: admin.firestore.Timestamp.fromDate(expiryDate),
      lastAppleReceiptValidation: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ User ${userId} upgraded to ${subscriptionType} via Apple IAP`);

    res.json({ 
      success: true, 
      message: 'User upgraded successfully',
      isPremium: true,
      subscriptionType: subscriptionType
    });

  } catch (error) {
    console.error('❌ Apple receipt validation error:', error);
    res.status(500).json({ error: 'Validation failed', details: error.message });
  }
});

// Restore Apple subscription
router.post('/restore-apple-subscription', async (req, res) => {
  try {
    const { userId, products } = req.body;

    if (!userId || !products) {
      return res.status(400).json({ error: 'Missing userId or products' });
    }

    console.log(`🔄 Restoring subscription for user ${userId}`);
    console.log('Products:', products);

    // Find the most recent/best subscription
    const activeProducts = products.filter(p => p.owned);
    
    if (activeProducts.length === 0) {
      console.log('⚠️ No active products found for restore');
      return res.json({ success: false, message: 'No active subscriptions found' });
    }

    // Prioritize yearly over monthly
    const bestProduct = activeProducts.find(p => p.id.includes('yearly')) || activeProducts[0];
    const subscriptionType = bestProduct.id.includes('yearly') ? 'yearly' : 'monthly';

    // Update user in Firebase
    await admin.firestore().collection('users').doc(userId).update({
      isPremium: true,
      subscriptionType: subscriptionType,
      subscriptionPlatform: 'apple',
      appleProductId: bestProduct.id,
      appleSubscriptionRestored: admin.firestore.FieldValue.serverTimestamp(),
      lastAppleReceiptValidation: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Subscription restored for user ${userId}`);

    res.json({ 
      success: true, 
      message: 'Subscription restored successfully',
      subscriptionType: subscriptionType
    });

  } catch (error) {
    console.error('❌ Restore subscription error:', error);
    res.status(500).json({ error: 'Restore failed', details: error.message });
  }
});

// Sync Apple subscription status (called on app load)
router.post('/sync-apple-subscription', async (req, res) => {
  try {
    const { userId, subscriptions } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    console.log(`🔄 Syncing Apple subscription for user ${userId}`);

    // Get user's current status
    const userDoc = await admin.firestore().collection('users').doc(userId).get();
    const userData = userDoc.data();

    // Check if user has active Apple subscriptions on device
    const hasActiveSubscription = subscriptions && subscriptions.length > 0;

    if (hasActiveSubscription) {
      // User has active subscription on device
      const bestSub = subscriptions.find(s => s.id.includes('yearly')) || subscriptions[0];
      const subscriptionType = bestSub.id.includes('yearly') ? 'yearly' : 'monthly';

      // Only update if not already premium or if subscription changed
      if (!userData?.isPremium || userData?.appleProductId !== bestSub.id) {
        await admin.firestore().collection('users').doc(userId).update({
          isPremium: true,
          subscriptionType: subscriptionType,
          subscriptionPlatform: 'apple',
          appleProductId: bestSub.id,
          lastAppleReceiptValidation: admin.firestore.FieldValue.serverTimestamp()
        });

        console.log(`✅ User ${userId} synced to premium (${subscriptionType})`);
        
        return res.json({ 
          success: true, 
          updated: true,
          subscriptionType: subscriptionType
        });
      } else {
        console.log(`✅ User ${userId} already premium, no update needed`);
        return res.json({ success: true, updated: false });
      }
    } else {
      // No active subscriptions on device
      // Check if user's Firebase subscription is expired
      if (userData?.subscriptionPlatform === 'apple' && userData?.appleSubscriptionExpiry) {
        const expiryDate = userData.appleSubscriptionExpiry.toDate();
        const now = new Date();
        
        if (now > expiryDate) {
          // Subscription expired - downgrade user
          await admin.firestore().collection('users').doc(userId).update({
            isPremium: false,
            subscriptionType: 'free',
            appleSubscriptionExpired: admin.firestore.FieldValue.serverTimestamp()
          });
          
          console.log(`⚠️ User ${userId} subscription expired - downgraded to free`);
          
          return res.json({ 
            success: true, 
            updated: true,
            expired: true
          });
        }
      }
      
      console.log(`✅ User ${userId} - no active Apple subscriptions found`);
      return res.json({ success: true, updated: false });
    }

  } catch (error) {
    console.error('❌ Sync subscription error:', error);
    res.status(500).json({ error: 'Sync failed', details: error.message });
  }
});

// Handle subscription expiration
router.post('/apple-subscription-expired', async (req, res) => {
  try {
    const { userId, productId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'Missing userId' });
    }

    console.log(`⏰ Subscription expired for user ${userId}, product: ${productId}`);

    // Downgrade user to free
    await admin.firestore().collection('users').doc(userId).update({
      isPremium: false,
      subscriptionType: 'free',
      appleSubscriptionExpired: admin.firestore.FieldValue.serverTimestamp(),
      previousAppleProductId: productId
    });

    console.log(`✅ User ${userId} downgraded to free`);

    res.json({ success: true, message: 'User downgraded' });

  } catch (error) {
    console.error('❌ Handle expiration error:', error);
    res.status(500).json({ error: 'Failed to handle expiration', details: error.message });
  }
});

module.exports = router;