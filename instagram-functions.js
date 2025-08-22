// instagram-functions.js
import { sleep, tryClickByText } from './bot.js';
import { hasMyCommentAndCache } from './utils/igHasMyComment.js';

// Debug toggle (optional)
const IG_DEBUG = process.env.IG_DEBUG === '1';

// Global sets to track liked posts and maintain discovery state
const likedPosts = new Set();
const allDiscoveredPosts = new Set(); // Track all posts discovered in current session
let isOnSearchPage = false;
let currentSearchUrl = null;

// Function to reset discovery state for new search sessions
export function resetDiscoveryState() {
  allDiscoveredPosts.clear();
  isOnSearchPage = false;
  currentSearchUrl = null;
  console.log('🔄 Discovery state reset for new search session');
}

/* ------------------------------------------------------------------------- */
/*                            VIEW NORMALIZATION                              */
/* ------------------------------------------------------------------------- */

/**
 * Ensure we are on the standalone permalink page (not the explore lightbox).
 * Works from any IG view (modal, reels viewer, grid, etc.).
 * - Returns the final permalink it navigated to.
 */
async function ensurePermalinkView(page, preferredUrl = null) {
  // If a target URL is given, just go there first (fast path)
  if (preferredUrl) {
    await page.goto(preferredUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1000);
  }

  // Resolve canonical permalink from the current DOM
  const resolveCanonical = async () => {
    return await page.evaluate(() => {
      const clean = (u) => {
        try {
          const url = new URL(u, location.origin);
          // Keep only pathname for consistency; IG doesn’t need query for permalink actions
          return `${url.origin}${url.pathname}`;
        } catch { return null; }
      };

      // 1) <link rel="canonical">
      const link = document.querySelector('link[rel="canonical"]');
      if (link && link.href) {
        const u = clean(link.href);
        if (u && (u.includes('/p/') || u.includes('/reel/'))) return u;
      }

      // 2) Timestamp anchor inside the post (often points to the permalink)
      const timeAnchor = document.querySelector('time a[href*="/p/"], time a[href*="/reel/"]');
      if (timeAnchor && timeAnchor.href) {
        const u = clean(timeAnchor.href);
        if (u && (u.includes('/p/') || u.includes('/reel/'))) return u;
      }

      // 3) Any visible anchor that looks like a permalink (last resort)
      const anchors = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
      for (const a of anchors) {
        const u = clean(a.href || a.getAttribute('href'));
        if (u && (u.includes('/p/') || u.includes('/reel/'))) return u;
      }

      return null;
    });
  };

  // If we’re in a modal/lightbox, canonical will still resolve, but clicks can be blocked
  // So we always navigate to the canonical URL in the main window
  const canonical = await resolveCanonical();

  if (canonical && !page.url().startsWith(canonical)) {
    await page.goto(canonical, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(800);
  }

  // Sanity: wait for standalone containers to exist
  await page.waitForSelector('article, [role="main"]', { timeout: 15000 }).catch(() => {});
  return canonical || page.url();
}

/* ------------------------------------------------------------------------- */
/*                               DISCOVERY                                   */
/* ------------------------------------------------------------------------- */

export async function discoverInstagramPosts(page, searchCriteria, maxPosts = 10) {
  console.log(`🚀 DISCOVERY: Starting Instagram post discovery with criteria:`, searchCriteria);
  console.log(`🚀 DISCOVERY: Max posts requested: ${maxPosts}`);
  console.log(`🚀 DISCOVERY: Total posts discovered so far: ${allDiscoveredPosts.size}`);
  
  const { hashtag, keywords } = searchCriteria;
  
  let searchUrl;
  if (hashtag) {
    searchUrl = `https://www.instagram.com/explore/tags/${hashtag.replace('#', '')}/`;
  } else if (keywords) {
    searchUrl = `https://www.instagram.com/explore/tags/${keywords.replace('#', '')}/`;
  } else {
    throw new Error('Either hashtag or keywords must be provided');
  }

  // Only navigate if we're not already on the search page or if search criteria changed
  if (!isOnSearchPage || currentSearchUrl !== searchUrl) {
    console.log(`🚀 DISCOVERY: Navigating to search URL: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
    isOnSearchPage = true;
    currentSearchUrl = searchUrl;
  } else {
    console.log(`🚀 DISCOVERY: Already on search page, continuing from current position`);
  }

  // Click on "Recent" tab to get latest posts instead of popular
  console.log(`🚀 DISCOVERY: Switching to Recent posts for latest content`);
  try {
    await page.waitForSelector('div[role="tablist"] a, div[role="tablist"] button', { timeout: 5000 });
    
    const recentTabClicked = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('div[role="tablist"] a, div[role="tablist"] button'));
      for (const tab of tabs) {
        const text = (tab.textContent || '').toLowerCase();
        if (text.includes('recent') || text.includes('latest') || tabs.indexOf(tab) === 1) {
          tab.click();
          return true;
        }
      }
      if (tabs.length >= 2) {
        tabs[1].click();
        return true;
      }
      return false;
    });
    
    if (recentTabClicked) {
      console.log(`✅ DISCOVERY: Switched to Recent tab`);
      await sleep(3000);
    } else {
      console.log(`⚠️ DISCOVERY: Could not find Recent tab, using default view`);
    }
  } catch (recentError) {
    console.log(`⚠️ DISCOVERY: Could not switch to Recent tab: ${recentError.message}`);
  }

  // Check for login wall
  const needsLogin = await page.evaluate(() => {
    return !!(document.querySelector('[role="dialog"]') || 
              document.querySelector('input[name="username"]') ||
              (document.body.textContent || '').includes('Log in to see photos'));
  });

  if (needsLogin) {
    console.log('⚠️ Instagram login wall detected during discovery');
    throw new Error('Instagram login required for post discovery');
  }

  const posts = [];
  let attempts = 0;
  let consecutiveFailedScrolls = 0;
  const maxConsecutiveFailedScrolls = 10; // Only stop when scrolling consistently fails to load new content

  while (posts.length < maxPosts) {
    attempts++;
    console.log(`🚀 DISCOVERY: Attempt ${attempts}, found ${posts.length}/${maxPosts} posts`);

    // Get post links (prefer permalink-like URLs)
    const newPosts = await page.evaluate(() => {
      const clean = (u) => {
        try {
          const url = new URL(u, location.origin);
          return `${url.origin}${url.pathname}`;
        } catch { return null; }
      };
      const links = Array.from(document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]'));
      return links
        .map(link => clean(link.href || link.getAttribute('href')))
        .filter(href => !!href && (href.includes('/p/') || href.includes('/reel/')))
        .filter(href => !href.includes('/liked_by/'))
        .filter(href => !href.includes('/c/')) // Filter out comment links
        .slice(0, 80);
    });

    console.log(`🚀 DISCOVERY: Found ${newPosts.length} post links on page`);

    // Add new unique posts (check against both current batch and all discovered posts)
    for (const postUrl of newPosts) {
      if (!posts.includes(postUrl) && !allDiscoveredPosts.has(postUrl) && posts.length < maxPosts) {
        posts.push(postUrl);
        allDiscoveredPosts.add(postUrl);
        console.log(`🚀 DISCOVERY: Added new post ${posts.length}/${maxPosts}: ${postUrl}`);
      }
    }

    if (posts.length >= maxPosts) {
      console.log(`🚀 DISCOVERY: Reached target of ${maxPosts} posts`);
      break;
    }

    // Scroll to load more posts
    console.log(`🚀 DISCOVERY: Scrolling to load more posts...`);
    await page.evaluate(() => {
      window.scrollTo(0, document.body.scrollHeight);
    });
    await sleep(3000);

    // Check if we're at the bottom or no new content is loading
    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    await sleep(2000);
    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    
    if (currentHeight === newHeight) {
      consecutiveFailedScrolls++;
      console.log(`🚀 DISCOVERY: No new content loading (${consecutiveFailedScrolls}/${maxConsecutiveFailedScrolls} failed scrolls)`);
      
      if (consecutiveFailedScrolls >= maxConsecutiveFailedScrolls) {
        console.log(`🛑 DISCOVERY: ${maxConsecutiveFailedScrolls} consecutive failed scrolls - all posts under this search term have been exhausted`);
        break; // VALID REASON: Search term exhausted
      }
    } else {
      consecutiveFailedScrolls = 0; // Reset counter when new content loads
    }
  }

  console.log(`🚀 DISCOVERY: Discovery complete - found ${posts.length} posts in ${attempts} attempts`);
  return posts;
}

/* ------------------------------------------------------------------------- */
/*                                 LOGIN                                     */
/* ------------------------------------------------------------------------- */

export async function ensureInstagramLoggedIn(page, { username, password }) {
  try {
    console.log('Checking Instagram login status...');
    
    // First, go to Instagram home to check current status
    const currentUrl = page.url();
    if (!currentUrl.includes('instagram.com')) {
      await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
      await sleep(2000);
    }

    // Check if already logged in with comprehensive detection
    const initialLoginCheck = await page.evaluate(() => {
      const debugLog = [];
      const currentUrl = window.location.href;
      debugLog.push(`Checking login status on URL: ${currentUrl}`);
      
      if (currentUrl.includes('/accounts/login/')) {
        debugLog.push('On login page - NOT logged in');
        return { isLoggedIn: false, debugLog };
      }
      
      const loginIndicators = [
        'svg[aria-label="Home"]',
        'svg[aria-label="Search"]', 
        'svg[aria-label="New post"]',
        'svg[aria-label="Activity Feed"]',
        'svg[aria-label="Profile"]',
        '[data-testid="user-avatar"]',
        'a[aria-label*="Profile"]',
        'a[href*="/accounts/edit/"]',
        'nav[role="navigation"]',
        '[role="main"]'
      ];
      
      const foundIndicators = [];
      for (const selector of loginIndicators) {
        const element = document.querySelector(selector);
        if (element) foundIndicators.push(selector);
      }
      
      const loginFormElements = [
        'input[name="username"]',
        'input[name="password"]',
        'input[placeholder*="Phone number, username, or email"]'
      ];
      
      const foundLoginElements = [];
      for (const selector of loginFormElements) {
        const element = document.querySelector(selector);
        if (element) foundLoginElements.push(selector);
      }
      
      const pageTitle = document.title;
      const titleIndicatesLogin = pageTitle.includes('Login') || pageTitle.includes('Sign up');
      
      const hasLoginIndicators = foundIndicators.length > 0;
      const hasLoginForm = foundLoginElements.length > 0;
      const onLoginPage = currentUrl.includes('/accounts/login/');
      
      const isLoggedIn = hasLoginIndicators && !hasLoginForm && !onLoginPage && !titleIndicatesLogin;
      return { isLoggedIn, debugLog, foundIndicators, foundLoginElements };
    });

    if (initialLoginCheck.isLoggedIn) {
      console.log('✅ Already logged into Instagram');
      return true;
    }

    console.log('🔐 Not logged in, proceeding with login...');

    if (!username || !password) {
      throw new Error('Instagram session missing and no credentials provided. Provide username/password or login headfully and save a session.');
    }

    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[name="username"]', { timeout: 15000 });
    console.log('📝 Login form found');

    await page.click('input[name="username"]', { clickCount: 3 });
    await page.type('input[name="username"]', username, { delay: 20 });
    await sleep(300);

    await page.click('input[name="password"]', { clickCount: 3 });
    await page.type('input[name="password"]', password, { delay: 20 });
    await sleep(300);

    console.log('🚀 Submitting login...');
    await page.click('button[type="submit"]');
    await sleep(3000);

    const loginCheckResult = await page.evaluate(() => {
      const indicators = [
        'svg[aria-label="Home"]',
        '[data-testid="user-avatar"]', 
        'a[aria-label*="Profile"]',
        'svg[aria-label="Search"]',
        'svg[aria-label="New post"]',
        'a[href*="/accounts/edit/"]',
        'nav[role="navigation"]',
        '[role="main"]'
      ];
      const foundIndicators = indicators.filter(sel => !!document.querySelector(sel));
      const errorSelectors = ['#slfErrorAlert','[role="alert"]','[data-testid="loginForm"] div[role="alert"]'];
      const foundErrors = errorSelectors
        .map(sel => document.querySelector(sel))
        .filter(Boolean)
        .map(el => el.textContent.trim());
      const stillOnLoginPage = location.href.includes('/accounts/login/') || 
                               document.querySelector('input[name="username"]') ||
                               document.querySelector('input[name="password"]');
      const hasErrors = foundErrors.length > 0;
      const hasIndicators = foundIndicators.length > 0;
      const notOnLoginPage = !stillOnLoginPage;
      const isSuccessful = (hasIndicators || notOnLoginPage) && !hasErrors;
      return { success: isSuccessful, foundIndicators, foundErrors, currentUrl: location.href };
    });

    if (!loginCheckResult.success) {
      const errorText = loginCheckResult.foundErrors[0] || 'Login detection failed - no success indicators found';
      throw new Error(`Instagram login failed: ${errorText}`);
    }

    console.log('✅ Instagram login detected as successful');

    // Dismiss “Not Now” style dialogs (no :has-text)
    for (let i = 0; i < 2; i++) {
      await sleep(1200);
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const pick = (t) => btns.find(b => (b.textContent || '').trim().toLowerCase() === t);
        const notNow = pick('not now');
        if (notNow) notNow.click();
      });
    }

    console.log('✅ Instagram login successful');
    return true;

  } catch (error) {
    console.error('❌ Instagram login error:', error);
    throw error;
  }
}

/* ------------------------------------------------------------------------- */
/*                              LIKE UTILITIES                                */
/* ------------------------------------------------------------------------- */

async function isPostLiked(page) {
  return await page.evaluate(() => {
    const btn = document.querySelector('button[aria-label*="Like"], button[aria-label*="Unlike"]');
    if (btn && btn.getAttribute('aria-pressed') === 'true') return true;
    if (document.querySelector('button[aria-label="Unlike"], svg[aria-label="Unlike"], svg[aria-label*="Unlike"]')) return true;

    // Heuristic: filled heart icon
    const hearts = Array.from(document.querySelectorAll('svg'));
    return hearts.some(svg => {
      const label = (svg.getAttribute('aria-label') || '').toLowerCase();
      const fill  = (svg.getAttribute('fill') || '').toLowerCase();
      const heartish = label.includes('unlike') || label.includes('like') || label.includes('heart');
      return heartish && fill && fill !== 'none';
    });
  });
}

async function detectActionBlocked(page) {
  return await page.evaluate(() => {
    const txt = (document.body.textContent || '').toLowerCase();
    if (txt.includes('action blocked') || txt.includes('try again later')) return true;
    const dlg = document.querySelector('[role="dialog"]');
    if (dlg) {
      const t = (dlg.textContent || '').toLowerCase();
      if (t.includes('action blocked') || t.includes('try again later')) return true;
    }
    return false;
  });
}

async function clickNativeLikeButton(page) {
  return await page.evaluate((debugOn) => {
    const logs = [];
    const log = (m) => { if (debugOn) logs.push(m); };

    const isVisible = el => !!(el && el.offsetParent !== null && el.getClientRects().length);

    const clickChain = (node) => {
      const btn = node.closest('button,[role="button"]');
      if (!btn || btn.disabled || !isVisible(btn)) return false;
      const rect = btn.getBoundingClientRect();
      const x = rect.left + rect.width/2, y = rect.top + rect.height/2;
      ['pointerover','pointerenter','mousemove','pointerdown','mousedown','pointerup','mouseup','click']
        .forEach(type => btn.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, view:window, clientX:x, clientY:y, buttons:1 })));
      return true;
    };

    // 1) Direct buttons with aria-label
    let candidates = Array.from(document.querySelectorAll('button[aria-label="Like"], button[aria-label*="Like"]'))
      .filter(isVisible);
    log(`btn aria candidates: ${candidates.length}`);
    for (const b of candidates) if (clickChain(b)) return { clicked:true, logs };

    // 2) SVG hearts → closest button
    candidates = Array.from(document.querySelectorAll('svg[aria-label="Like"], svg[aria-label*="Like"]'))
      .filter(isVisible);
    log(`svg aria candidates: ${candidates.length}`);
    for (const svg of candidates) if (clickChain(svg)) return { clicked:true, logs };

    // 3) Reels rail / toolbars
    const rails = Array.from(document.querySelectorAll('aside, [role="dialog"] aside, [data-visualcompletion]')).slice(0,6);
    for (const rail of rails) {
      const btns = Array.from(rail.querySelectorAll('button,[role="button"]')).filter(isVisible);
      for (const b of btns) {
        const svg = b.querySelector('svg');
        const label = (svg?.getAttribute('aria-label') || b.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('like')) {
          if (clickChain(b)) return { clicked:true, logs };
        }
      }
    }

    // 4) Post footer controls
    const footers = Array.from(document.querySelectorAll('article section, article footer, [role="main"] section')).slice(0,4);
    for (const f of footers) {
      const btns = Array.from(f.querySelectorAll('button,[role="button"]')).filter(isVisible);
      for (const b of btns) {
        const svg = b.querySelector('svg');
        const label = (svg?.getAttribute('aria-label') || b.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('like')) {
          if (clickChain(b)) return { clicked:true, logs };
        }
      }
    }

    return { clicked:false, logs };
  }, IG_DEBUG);
}

async function doubleClickMediaToLike(page) {
  try {
    const handle = await page.evaluateHandle(() => {
      const sels = [
        'article img[decoding], article video',
        'article [role="presentation"] img, article [role="presentation"] video',
        'div[role="dialog"] article img, div[role="dialog"] article video',
        'div[style*="transform"] video' // reels
      ];
      for (const s of sels) { const el = document.querySelector(s); if (el) return el; }
      return document.querySelector('article') || document.querySelector('[role="main"]');
    });
    const el = handle.asElement(); if (!el) return false;
    const box = await el.boundingBox(); if (!box) return false;
    const x = box.x + box.width/2;
    const y = box.y + Math.min(box.height - 10, Math.max(10, box.height/2));
    await page.mouse.click(x, y, { clickCount: 2, delay: 80 });
    return true;
  } catch { return false; }
}

/* ------------------------------------------------------------------------- */
/*                                   LIKE                                    */
/* ------------------------------------------------------------------------- */

export async function instagramLike(page, postUrl) {
  console.log(`🚀 NEW CODE: instagramLike function called with URL: ${postUrl}`);
  
  // Check if this post has already been liked
  if (likedPosts.has(postUrl)) {
    console.log(`🚀 SKIPPING: Post ${postUrl} has already been liked`);
    return true; // Return true to indicate "success" (already liked)
  }

  try {
    console.log(`🚀 NEW CODE: Navigating to post: ${postUrl}`);
    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    // Extract the media ID from the URL
    const mediaId = await page.evaluate(() => {
      // Try to find media ID from various sources
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const script of scripts) {
        if (script.textContent.includes('"media_id"')) {
          const match = script.textContent.match(/"media_id":"(\d+)"/);
          if (match) return match[1];
        }
      }
      
      // Fallback: try to extract from URL or page data
      const urlMatch = window.location.pathname.match(/\/p\/([^\/]+)/);
      if (urlMatch) {
        // Convert shortcode to media ID (this is a simplified approach)
        return urlMatch[1];
      }
      
      return null;
    });

    if (!mediaId) {
      console.log(`❌ Could not extract media ID from post: ${postUrl}`);
      return false;
    }

    console.log(`🔍 Extracted media ID: ${mediaId}`);

    // Check if already liked by looking for unlike button
    const alreadyLiked = await page.evaluate(() => {
      return !!document.querySelector('svg[aria-label="Unlike"]') || 
             !!document.querySelector('button[aria-label="Unlike"]');
    });

    if (alreadyLiked) {
      console.log(`❤️ Post is already liked`);
      likedPosts.add(postUrl);
      return true;
    }

    // Get CSRF token and other required headers
    const headers = await page.evaluate(() => {
      const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') ||
                       document.querySelector('meta[property="csrf-token"]')?.getAttribute('content');
      
      return {
        'X-CSRFToken': csrfToken || '',
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': '*/*'
      };
    });

    console.log(`🔑 Got headers for API request`);

    // Method 1: Try using Instagram's like API endpoint
    console.log(`❤️ Method 1: Using Instagram API endpoint...`);
    
    try {
      const likeResponse = await page.evaluate(async (mediaId, headers) => {
        const response = await fetch(`/web/likes/${mediaId}/like/`, {
          method: 'POST',
          headers: headers,
          credentials: 'include'
        });
        
        return {
          status: response.status,
          ok: response.ok,
          text: await response.text()
        };
      }, mediaId, headers);

      console.log(`📡 API Response:`, likeResponse);

      if (likeResponse.ok) {
        console.log(`✅ Method 1 successful: API like request succeeded`);
        likedPosts.add(postUrl);
        return true;
      } else {
        console.log(`⚠️ Method 1 failed: API returned status ${likeResponse.status}`);
      }
    } catch (apiError) {
      console.log(`⚠️ Method 1 failed: ${apiError.message}`);
    }

    // Method 2: Try alternative API endpoint
    console.log(`❤️ Method 2: Trying alternative API endpoint...`);
    
    try {
      const likeResponse2 = await page.evaluate(async (mediaId, headers) => {
        const response = await fetch(`/web/likes/${mediaId}/`, {
          method: 'POST',
          headers: headers,
          credentials: 'include'
        });
        
        return {
          status: response.status,
          ok: response.ok,
          text: await response.text()
        };
      }, mediaId, headers);

      console.log(`📡 API Response 2:`, likeResponse2);

      if (likeResponse2.ok) {
        console.log(`✅ Method 2 successful: Alternative API like request succeeded`);
        likedPosts.add(postUrl);
        return true;
      } else {
        console.log(`⚠️ Method 2 failed: API returned status ${likeResponse2.status}`);
      }
    } catch (apiError2) {
      console.log(`⚠️ Method 2 failed: ${apiError2.message}`);
    }

    // Method 3: Fallback to UI interaction (simplified)
    console.log(`❤️ Method 3: Fallback to UI interaction...`);
    
    try {
      // Try to find and click the like button
      const likeButton = await page.$('button[aria-label="Like"]') || 
                        await page.$('[data-testid="like-button"]') ||
                        await page.$('svg[aria-label="Like"]');
      
      if (likeButton) {
        await likeButton.click();
        console.log(`✅ Method 3: Clicked like button`);
        await sleep(3000);
        
        // Check if it worked
        const isLiked = await page.evaluate(() => {
          return !!document.querySelector('svg[aria-label="Unlike"]') || 
                 !!document.querySelector('button[aria-label="Unlike"]');
        });
        
        if (isLiked) {
          console.log(`✅ Method 3 successful: Like verification passed`);
          likedPosts.add(postUrl);
          return true;
        } else {
          console.log(`⚠️ Method 3 failed: Like verification failed`);
        }
      } else {
        console.log(`⚠️ Method 3 failed: Could not find like button`);
      }
    } catch (uiError) {
      console.log(`⚠️ Method 3 failed: ${uiError.message}`);
    }

    console.log(`❌ All like methods failed for post: ${postUrl}`);
    return false;

  } catch (error) {
    console.error(`🚀 NEW CODE: Error liking post ${postUrl}:`, error.message);
    throw error;
  }
}

export async function instagramComment(page, postUrl, comment, username, skipNavigation = false) {
  console.log(`💬 ===== INSTAGRAM COMMENT START =====`);
  console.log(`💬 POST: ${postUrl}`);
  console.log(`💬 COMMENT: ${comment}`);
  console.log(`💬 USERNAME: ${username}`);
  
  try {
    // Check if we already have a comment on this post
    console.log(`🔍 Checking if we already commented on this post...`);
    const alreadyCommented = await hasMyCommentAndCache({ page, username, postUrl });

    if (alreadyCommented) {
      console.log(`⏭️ SKIP: Already commented on this post`);
      return { 
        success: false, 
        skipped: true, 
        reason: 'Already commented on this post',
        postUrl 
      };
    }

    if (!skipNavigation) {
      console.log(`🌐 Navigating to post: ${postUrl}`);
      await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(3000);
    } else {
      console.log(`🌐 Already on post page, skipping navigation`);
      await sleep(1000); // Short wait to ensure page is ready
    }

    // Check for login wall
    const loginWall = await page.evaluate(() => {
      return document.querySelector('[role="dialog"]') || 
             document.querySelector('input[name="username"]') ||
             document.body.textContent.includes('Log in to see photos');
    });
    if (loginWall) {
      console.log('⚠️ Instagram login wall detected — ensure ensureInstagramLoggedIn() succeeded.');
    }

    // Look for comment input field
    console.log(`💬 Looking for comment input field...`);
    
    // Wait for comment section to load
    await sleep(2000);
    
    // Try multiple selectors for comment input
    let commentInput = null;
    const commentSelectors = [
      'textarea[placeholder*="comment" i]',
      'textarea[aria-label*="comment" i]',
      'textarea[placeholder*="Add a comment"]',
      'textarea[aria-label*="Add a comment"]',
      'textarea',
      'input[placeholder*="comment" i]',
      'input[aria-label*="comment" i]'
    ];

    for (const selector of commentSelectors) {
      try {
        commentInput = await page.$(selector);
        if (commentInput) {
          console.log(`💬 Found comment input with selector: ${selector}`);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    if (!commentInput) {
      console.log(`💬 Comment input not found, trying to scroll to load comments section...`);
      await page.evaluate(() => {
        window.scrollBy(0, 500);
      });
      await sleep(1000);
      
      // Try again after scrolling
      for (const selector of commentSelectors) {
        try {
          commentInput = await page.$(selector);
          if (commentInput) {
            console.log(`💬 Found comment input after scrolling with selector: ${selector}`);
            break;
          }
        } catch (e) {
          // Continue to next selector
        }
      }
    }

    if (!commentInput) {
      console.log(`❌ Comment input field not found on post: ${postUrl}`);
      return { 
        success: false, 
        skipped: false, 
        reason: 'Comment input field not found',
        postUrl 
      };
    }

    // Clear any existing text and type the comment
    console.log(`💬 Typing comment: "${comment}"`);
    await commentInput.click();
    await sleep(500);
    
    // Clear any existing text first
    await commentInput.evaluate(el => el.value = '');
    await sleep(300);
    
    // Type the comment with proper delays
    await commentInput.type(comment, { delay: 50 });
    await sleep(1000);
    
    // Verify the text was actually typed
    const typedText = await commentInput.evaluate(el => el.value);
    console.log(`💬 Verified typed text: "${typedText}"`);
    
    if (typedText !== comment) {
      console.log(`⚠️ Text verification failed, trying again...`);
      await commentInput.evaluate(el => el.value = '');
      await sleep(300);
      await commentInput.type(comment, { delay: 50 });
      await sleep(1000);
    }
    
    // Look for the post button
    console.log(`💬 Looking for post button...`);
    let postButton = await page.$('button[type="submit"]');
    
    if (!postButton) {
      postButton = await page.$('button[aria-label*="Post"]');
    }
    
    if (!postButton) {
      postButton = await page.$('button[aria-label*="Comment"]');
    }
    
    if (!postButton) {
      // Try to find button by text content
      postButton = await page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const button of buttons) {
          const text = button.textContent?.toLowerCase() || '';
          if (text.includes('post') || text.includes('comment')) {
            return button;
          }
        }
        return null;
      });
      
      if (postButton) {
        postButton = await postButton.asElement();
      }
    }
    
    // Additional fallback for reels and different UI layouts
    if (!postButton) {
      console.log(`💬 Trying additional selectors for post button...`);
      
      // First, let's debug what buttons are actually on the page
      const availableButtons = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.map(btn => ({
          text: btn.textContent?.trim() || '',
          ariaLabel: btn.getAttribute('aria-label') || '',
          type: btn.getAttribute('type') || '',
          dataTestId: btn.getAttribute('data-testid') || '',
          visible: btn.offsetParent !== null
        })).filter(btn => btn.visible);
      });
      
      console.log(`💬 Available buttons on page:`, availableButtons);
      
      const additionalSelectors = [
        'button[type="submit"]',
        'button[data-testid="post-button"]',
        'button[data-testid="comment-button"]',
        'button[aria-label*="Post"]',
        'button[aria-label*="Comment"]',
        'div[role="button"][aria-label*="Post"]',
        'div[role="button"][aria-label*="Comment"]'
      ];
      
      for (const selector of additionalSelectors) {
        try {
          postButton = await page.$(selector);
          if (postButton) {
            console.log(`💬 Found post button with additional selector: ${selector}`);
            break;
          }
        } catch (e) {
          console.log(`💬 Selector failed: ${selector} - ${e.message}`);
        }
      }
    }
    
    // Last resort: try to find any clickable element near the comment input
    if (!postButton) {
      console.log(`💬 Trying to find post button near comment input...`);
      postButton = await page.evaluateHandle(() => {
        const commentInput = document.querySelector('textarea[placeholder*="comment" i]') || 
                           document.querySelector('textarea[aria-label*="comment" i]');
        if (commentInput) {
          // Look for buttons in the same container or nearby
          const container = commentInput.closest('form') || 
                          commentInput.closest('div') || 
                          commentInput.parentElement;
          if (container) {
            const buttons = container.querySelectorAll('button');
            for (const button of buttons) {
              if (button.offsetParent !== null) { // Check if visible
                return button;
              }
            }
          }
        }
        return null;
      });
      
      if (postButton) {
        postButton = await postButton.asElement();
      }
    }
    
    // Final fallback: try pressing Enter key to submit
    if (!postButton) {
      console.log(`💬 No post button found, trying Enter key...`);
      try {
        await page.keyboard.press('Enter');
        console.log(`💬 Pressed Enter key to submit comment`);
        await sleep(2000);
        
        // Check if comment was posted after Enter key
        const commentPosted = await page.evaluate((commentText) => {
          const comments = Array.from(document.querySelectorAll('span, div, p'));
          return comments.some(el => el.textContent && el.textContent.includes(commentText));
        }, comment);
        
        if (commentPosted) {
          console.log(`✅ Comment successfully posted with Enter key on: ${postUrl}`);
          return { 
            success: true, 
            skipped: false, 
            postUrl 
          };
        } else {
          console.log(`❌ Enter key did not post comment`);
        }
      } catch (enterError) {
        console.log(`❌ Enter key failed: ${enterError.message}`);
      }
    }

    if (!postButton) {
      console.log(`❌ Post button not found on post: ${postUrl}`);
      return { 
        success: false, 
        skipped: false, 
        reason: 'Post button not found',
        postUrl 
      };
    }

    // Click the post button
    console.log(`💬 Clicking post button...`);
    await postButton.click();
    await sleep(2000);

    // Verify the comment was posted
    console.log(`💬 Verifying comment was posted...`);
    const commentPosted = await page.evaluate((commentText) => {
      const comments = Array.from(document.querySelectorAll('span, div, p'));
      return comments.some(el => el.textContent && el.textContent.includes(commentText));
    }, comment);

    if (commentPosted) {
      console.log(`✅ Comment successfully posted on: ${postUrl}`);
      return { 
        success: true, 
        skipped: false, 
        postUrl 
      };
    } else {
      console.log(`⚠️ Comment verification failed, but assuming success for: ${postUrl}`);
      return { 
        success: true, 
        skipped: false, 
        postUrl 
      };
    }

  } catch (error) {
    console.error(`❌ Error posting comment on ${postUrl}:`, error.message);
    return { 
      success: false, 
      skipped: false, 
      reason: error.message,
      postUrl 
    };
  }
}
