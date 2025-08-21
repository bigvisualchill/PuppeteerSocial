// instagram-functions.js
import { sleep, tryClickByText } from './bot.js';
import { hasMyCommentAndCache } from './utils/igHasMyComment.js';

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

// Post Discovery Functions
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
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
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
      // Look for Recent tab - could be text or could be an icon
      const tabs = Array.from(document.querySelectorAll('div[role="tablist"] a, div[role="tablist"] button'));
      
      for (const tab of tabs) {
        const text = tab.textContent?.toLowerCase() || '';
        // Look for "Recent" text or check if it's the second tab (Recent is usually after Top)
        if (text.includes('recent') || text.includes('latest') || tabs.indexOf(tab) === 1) {
          console.log('Found Recent tab, clicking...');
          tab.click();
          return true;
        }
      }
      
      // If no text match, try clicking the second tab (Recent is typically 2nd)
      if (tabs.length >= 2) {
        console.log('No Recent text found, clicking second tab (likely Recent)');
        tabs[1].click();
        return true;
      }
      
      return false;
    });
    
    if (recentTabClicked) {
      console.log(`✅ DISCOVERY: Switched to Recent tab`);
      await sleep(3000); // Wait for recent posts to load
    } else {
      console.log(`⚠️ DISCOVERY: Could not find Recent tab, using default view`);
    }
  } catch (recentError) {
    console.log(`⚠️ DISCOVERY: Could not switch to Recent tab: ${recentError.message}`);
  }

  // Check for login wall
  const needsLogin = await page.evaluate(() => {
    return document.querySelector('[role="dialog"]') || 
           document.querySelector('input[name="username"]') ||
           document.body.textContent.includes('Log in to see photos');
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

    // Get post links
    const newPosts = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/p/"]'));
      return links
        .map(link => link.href)
        .filter(href => href.includes('/p/'))
        .slice(0, 50); // Limit to avoid overwhelming
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

// Instagram flows
export async function ensureInstagramLoggedIn(page, { username, password }) {
  try {
    console.log('Checking Instagram login status...');
    
    // First, go to Instagram home to check current status
    const currentUrl = page.url();
    if (!currentUrl.includes('instagram.com')) {
      await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
      await sleep(2000);
    }

    // Check if already logged in with comprehensive detection
    const initialLoginCheck = await page.evaluate(() => {
      const debugLog = [];
      const currentUrl = window.location.href;
      debugLog.push(`Checking login status on URL: ${currentUrl}`);
      
      // First check: Are we on a login page?
      if (currentUrl.includes('/accounts/login/')) {
        debugLog.push('On login page - NOT logged in');
        return { isLoggedIn: false, debugLog };
      }
      
      // Second check: Look for login indicators
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
        if (element) {
          foundIndicators.push(selector);
        }
      }
      debugLog.push(`Found login indicators: ${foundIndicators.join(', ')}`);
      
      // Third check: Look for login form elements (indicates NOT logged in)
      const loginFormElements = [
        'input[name="username"]',
        'input[name="password"]',
        'input[placeholder*="Phone number, username, or email"]'
      ];
      
      const foundLoginElements = [];
      for (const selector of loginFormElements) {
        const element = document.querySelector(selector);
        if (element) {
          foundLoginElements.push(selector);
        }
      }
      debugLog.push(`Found login form elements: ${foundLoginElements.join(', ')}`);
      
      // Fourth check: Check page title
      const pageTitle = document.title;
      debugLog.push(`Page title: ${pageTitle}`);
      
      const titleIndicatesLogin = pageTitle.includes('Login') || pageTitle.includes('Sign up');
      if (titleIndicatesLogin) {
        debugLog.push('Page title indicates login page - NOT logged in');
      }
      
      // Determine login status
      const hasLoginIndicators = foundIndicators.length > 0;
      const hasLoginForm = foundLoginElements.length > 0;
      const onLoginPage = currentUrl.includes('/accounts/login/');
      
      // We're logged in if we have indicators AND no login form AND not on login page
      const isLoggedIn = hasLoginIndicators && !hasLoginForm && !onLoginPage && !titleIndicatesLogin;
      
      debugLog.push(`Login status determination:`);
      debugLog.push(`  - Has login indicators: ${hasLoginIndicators} (${foundIndicators.length})`);
      debugLog.push(`  - Has login form: ${hasLoginForm}`);
      debugLog.push(`  - On login page: ${onLoginPage}`);
      debugLog.push(`  - Title indicates login: ${titleIndicatesLogin}`);
      debugLog.push(`  - Final result: ${isLoggedIn}`);
      
      return { isLoggedIn, debugLog, foundIndicators, foundLoginElements };
    });

    // Log debug information
    console.log('=== Instagram Login Status Check ===');
    initialLoginCheck.debugLog.forEach(log => console.log(log));
    console.log('====================================');

    if (initialLoginCheck.isLoggedIn) {
      console.log('✅ Already logged into Instagram');
      return true;
    }

    console.log('🔐 Not logged in, proceeding with login...');

    // Validate credentials before attempting login
    if (!username || !password) {
      throw new Error('Instagram session missing and no credentials provided. Provide username/password or login headfully and save a session.');
    }

    // Navigate to login page if not already there
    const needsNavigation = await page.evaluate(() => {
      return !document.querySelector('input[name="username"]');
    });

    if (needsNavigation) {
      console.log('📍 Navigating to Instagram login page...');
      await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2' });
      await sleep(2000);
    }

    // Wait for login form
    await page.waitForSelector('input[name="username"]', { timeout: 10000 });
    console.log('📝 Login form found');

    // Clear and fill username
    await page.click('input[name="username"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.type('input[name="username"]', username);
    await sleep(500);

    // Clear and fill password
    await page.click('input[name="password"]');
    await page.keyboard.down('Control');
    await page.keyboard.press('a');
    await page.keyboard.up('Control');
    await page.type('input[name="password"]', password);
    await sleep(500);

    // Submit login
    console.log('🚀 Submitting login...');
    await page.click('button[type="submit"]');
    
    // Wait for navigation or error
    await sleep(3000);

    // Check for login success with comprehensive debugging
    const loginCheckResult = await page.evaluate(() => {
      const debugLog = [];
      const currentUrl = window.location.href;
      debugLog.push(`Current URL after login: ${currentUrl}`);
      
      // Look for successful login indicators
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
      
      const foundIndicators = [];
      for (const selector of indicators) {
        const element = document.querySelector(selector);
        if (element) {
          foundIndicators.push(selector);
        }
      }
      debugLog.push(`Found login indicators: ${foundIndicators.join(', ')}`);
      
      // Check for error messages
      const errorSelectors = [
        '#slfErrorAlert',
        '[role="alert"]',
        '[data-testid="loginForm"] div[role="alert"]'
      ];
      
      const foundErrors = [];
      let hasTextError = false;
      
      for (const selector of errorSelectors) {
        const element = document.querySelector(selector);
        if (element && element.textContent.trim()) {
          foundErrors.push(`${selector}: ${element.textContent.trim()}`);
        }
      }
      
      // Check for text-based error messages
      if (document.body.textContent.includes('Sorry, your password was incorrect') ||
          document.body.textContent.includes('The username you entered')) {
        hasTextError = true;
        foundErrors.push('Text-based error message found');
      }
      
      debugLog.push(`Found error messages: ${foundErrors.length > 0 ? foundErrors.join(', ') : 'None'}`);
      
      // Check if we're still on login page
      const stillOnLoginPage = currentUrl.includes('/accounts/login/') || 
                              document.querySelector('input[name="username"]') ||
                              document.querySelector('input[name="password"]');
      
      debugLog.push(`Still on login page: ${stillOnLoginPage}`);
      
      // Determine success - we're successful if:
      // 1. We have login indicators AND no errors, OR
      // 2. We're not on login page and no errors
      const hasErrors = foundErrors.length > 0 || hasTextError;
      const hasIndicators = foundIndicators.length > 0;
      const notOnLoginPage = !stillOnLoginPage;
      
      const isSuccessful = (hasIndicators || notOnLoginPage) && !hasErrors;
      
      debugLog.push(`Login success determination:`);
      debugLog.push(`  - Has indicators: ${hasIndicators}`);
      debugLog.push(`  - Not on login page: ${notOnLoginPage}`);
      debugLog.push(`  - Has errors: ${hasErrors}`);
      debugLog.push(`  - Final result: ${isSuccessful}`);
      
      return {
        success: isSuccessful,
        debugLog,
        foundIndicators,
        foundErrors,
        currentUrl
      };
    });

    // Log all debug information
    console.log('=== Instagram Login Success Detection ===');
    loginCheckResult.debugLog.forEach(log => console.log(log));
    console.log('==========================================');

    if (!loginCheckResult.success) {
      // Get more specific error information
      const errorText = loginCheckResult.foundErrors.length > 0 
        ? loginCheckResult.foundErrors[0] 
        : 'Login detection failed - no success indicators found';
      
      throw new Error(`Instagram login failed: ${errorText}`);
    }

    console.log('✅ Instagram login detected as successful');

    // Handle potential "Save Login Info" dialog
    try {
      await sleep(2000);
      const saveInfoDialog = await page.$('button:has-text("Not Now")') || 
                            await page.$('button:has-text("Save Info")');
      if (saveInfoDialog) {
        console.log('📱 Dismissing "Save Login Info" dialog...');
        await page.click('button:has-text("Not Now")');
        await sleep(1000);
      }
    } catch (e) {
      // Dialog might not appear, that's fine
    }

    // Handle potential notification dialog
    try {
      await sleep(2000);
      const notificationDialog = await page.$('button:has-text("Not Now")') ||
                                await page.$('button:has-text("Turn On")');
      if (notificationDialog) {
        console.log('🔔 Dismissing notification dialog...');
        await page.click('button:has-text("Not Now")');
        await sleep(1000);
      }
    } catch (e) {
      // Dialog might not appear, that's fine
    }

    console.log('✅ Instagram login successful');
    return true;

  } catch (error) {
    console.error('❌ Instagram login error:', error);
    throw error;
  }
}

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

    // Check if already liked with comprehensive debugging
    console.log(`❤️ Checking if post is already liked...`);
    const likeStatus = await page.evaluate(() => {
      const debug = {
        currentUrl: window.location.href,
        foundElements: [],
        isLiked: false
      };
      
      // Check for liked state with multiple indicators
      const likedSelectors = [
        'svg[aria-label="Unlike"]',
        'svg[fill="#ed4956"]',
        'button[aria-label="Unlike"]',
        '[data-testid="unlike-button"]',
        'svg[aria-label*="Unlike"]'
      ];
      
      for (const selector of likedSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          debug.foundElements.push({ selector, found: true });
          debug.isLiked = true;
        } else {
          debug.foundElements.push({ selector, found: false });
        }
      }
      
      // Also check for unliked state
      const unlikedSelectors = [
        'svg[aria-label="Like"]',
        'button[aria-label="Like"]',
        '[data-testid="like-button"]'
      ];
      
      for (const selector of unlikedSelectors) {
        const element = document.querySelector(selector);
        if (element) {
          debug.foundElements.push({ selector, found: true, state: 'unliked' });
        }
      }
      
      return debug;
    });
    
    console.log(`❤️ Like status check:`, likeStatus);
    
    if (likeStatus.isLiked) {
      console.log(`❤️ Post is already liked, marking as complete`);
      likedPosts.add(postUrl);
      return true;
    }



    // Find and click like button with comprehensive search
    console.log(`❤️ Looking for like button with multiple selectors...`);
    
    const likeSelectors = [
      'svg[aria-label="Like"]',
      'button[aria-label="Like"]', 
      'span[aria-label="Like"]',
      '[data-testid="like-button"]',
      'article button:first-of-type', // First button in article is usually like
      'article svg:first-of-type', // First SVG in article
      '[role="button"] svg', // SVG inside role=button
    ];
    
    let likeButton = null;
    for (const selector of likeSelectors) {
      try {
        likeButton = await page.$(selector);
        if (likeButton) {
          console.log(`❤️ Found like button with selector: ${selector}`);
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }

    if (!likeButton) {
      // Comprehensive debugging of page structure
      const pageDebug = await page.evaluate(() => {
        const debug = {
          url: window.location.href,
          title: document.title,
          articleElements: [],
          buttons: [],
          svgs: [],
          likeRelatedElements: []
        };
        
        // Check for article elements
        const articles = document.querySelectorAll('article');
        debug.articleElements = Array.from(articles).map((art, i) => ({
          index: i,
          hasButtons: art.querySelectorAll('button').length,
          hasSvgs: art.querySelectorAll('svg').length,
          firstButtonAria: art.querySelector('button')?.getAttribute('aria-label'),
          firstSvgAria: art.querySelector('svg')?.getAttribute('aria-label')
        }));
        
        // Check all buttons
        const allButtons = document.querySelectorAll('button, [role="button"]');
        debug.buttons = Array.from(allButtons).slice(0, 10).map(btn => ({
          ariaLabel: btn.getAttribute('aria-label'),
          textContent: btn.textContent?.trim().slice(0, 30),
          role: btn.getAttribute('role'),
          className: btn.className?.slice(0, 50)
        }));
        
        // Check all SVGs
        const allSvgs = document.querySelectorAll('svg');
        debug.svgs = Array.from(allSvgs).slice(0, 10).map(svg => ({
          ariaLabel: svg.getAttribute('aria-label'),
          fill: svg.getAttribute('fill'),
          className: svg.className?.slice(0, 50)
        }));
        
        // Look for like-related elements
        const likeElements = document.querySelectorAll('[aria-label*="like"], [aria-label*="Like"], [data-testid*="like"]');
        debug.likeRelatedElements = Array.from(likeElements).map(el => ({
          tagName: el.tagName,
          ariaLabel: el.getAttribute('aria-label'),
          dataTestId: el.getAttribute('data-testid')
        }));
        
        return debug;
      });
      
      console.log(`❤️ COMPREHENSIVE DEBUG:`, JSON.stringify(pageDebug, null, 2));
      
      // Try fallback: click on first heart-like element
      console.log(`❤️ Trying fallback: clicking first heart-like element...`);
      const fallbackClick = await page.evaluate(() => {
        // Look for any element that might be a like button
        const possibleLikeElements = [
          ...document.querySelectorAll('svg'),
          ...document.querySelectorAll('button'),
          ...document.querySelectorAll('[role="button"]')
        ];
        
        // Find the first one that looks like it could be a like button
        for (const el of possibleLikeElements) {
          const ariaLabel = el.getAttribute('aria-label') || '';
          const className = el.className || '';
          const textContent = el.textContent || '';
          
          // Check if it looks like a like button
          if (ariaLabel.toLowerCase().includes('like') || 
              ariaLabel.toLowerCase().includes('heart') ||
              className.toLowerCase().includes('like') ||
              textContent.includes('❤️') ||
              textContent.includes('♥')) {
            el.click();
            return { clicked: true, element: { ariaLabel, className: className.slice(0, 30) } };
          }
        }
        
        // If no obvious like button, try clicking the first SVG in the article
        const article = document.querySelector('article');
        if (article) {
          const firstSvg = article.querySelector('svg');
          if (firstSvg) {
            firstSvg.click();
            return { clicked: true, element: { type: 'first-svg-in-article' } };
          }
        }
        
        return { clicked: false };
      });
      
      if (fallbackClick.clicked) {
        console.log(`❤️ Fallback click successful:`, fallbackClick.element);
        await sleep(2000);
      } else {
        throw new Error('Like button not found and fallback failed');
      }
    }

    console.log(`❤️ Clicking like button...`);
    await likeButton.click();
    await sleep(1000);
    
    // Try multiple click methods if first doesn't work
    const clickResult = await page.evaluate(() => {
      // Check if like was successful after first click
      const likedAfterFirstClick = document.querySelector('svg[aria-label="Unlike"]') || 
                                  document.querySelector('svg[fill="#ed4956"]');
      
      if (likedAfterFirstClick) {
        return { success: true, method: 'first-click' };
      }
      
      // Try clicking again with different approach
      const likeButton = document.querySelector('svg[aria-label="Like"]') ||
                        document.querySelector('button[aria-label="Like"]') ||
                        document.querySelector('[data-testid="like-button"]');
      
      if (likeButton) {
        likeButton.click();
        return { success: true, method: 'second-click' };
      }
      
      // Try keyboard shortcut (double-tap space or L key)
      return { success: false, method: 'no-more-options' };
    });
    
    console.log(`❤️ Click result:`, clickResult);
    await sleep(2000); // Wait for any animation

    // Verify the like was successful with comprehensive checking
    console.log(`❤️ Verifying like was successful...`);
    const likeVerification = await page.evaluate(() => {
      const verification = {
        isLiked: false,
        foundElements: [],
        currentUrl: window.location.href
      };
      
      // Check for liked state indicators
      const likedIndicators = [
        'svg[aria-label="Unlike"]',
        'svg[fill="#ed4956"]',
        'button[aria-label="Unlike"]',
        '[data-testid="unlike-button"]',
        'svg[aria-label*="Unlike"]'
      ];
      
      for (const selector of likedIndicators) {
        const element = document.querySelector(selector);
        if (element) {
          verification.foundElements.push({ selector, found: true });
          verification.isLiked = true;
        }
      }
      
      // Also check if unliked indicators are gone
      const unlikedIndicators = [
        'svg[aria-label="Like"]',
        'button[aria-label="Like"]',
        '[data-testid="like-button"]'
      ];
      
      for (const selector of unlikedIndicators) {
        const element = document.querySelector(selector);
        if (!element) {
          verification.foundElements.push({ selector, found: false, note: 'unliked indicator gone' });
        }
      }
      
      return verification;
    });
    
    console.log(`❤️ Like verification result:`, likeVerification);
    
    const likeSuccessful = likeVerification.isLiked;

    if (likeSuccessful) {
      console.log(`🚀 NEW CODE: Successfully liked post: ${postUrl}`);
      likedPosts.add(postUrl);
      return true;
    } else {
      throw new Error('Like action did not complete successfully');
    }

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
      await sleep(2000);

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
      throw new Error('Comment input field not found');
    }

    // Click on the comment input to focus it
    console.log(`💬 Clicking on comment input to focus...`);
    await commentInput.click();
    await sleep(1000);

    // Type the comment
    console.log(`💬 Typing comment: "${comment}"`);
    await commentInput.type(comment);
    await sleep(1000);

    // Submit the comment
    console.log(`💬 Submitting comment...`);
    
    // Try to find and click submit button
    let submitted = false;
    
    // Method 1: Look for Post/Submit button using valid CSS selectors
    const submitSelectors = [
      'button[type="submit"]'
    ];

    for (const selector of submitSelectors) {
      try {
        const submitBtn = await page.$(selector);
        if (submitBtn) {
          console.log(`💬 Found submit button with selector: ${selector}`);
          await submitBtn.click();
          submitted = true;
          break;
        }
      } catch (e) {
        // Continue to next selector
      }
    }
    
    // Method 1b: Try finding Post button by text content using page.evaluate
    if (!submitted) {
      console.log(`💬 Trying to find Post button by text content...`);
      const buttonInfo = await page.evaluate(() => {
        // Look for buttons near the comment input area specifically
        const commentInput = document.querySelector('textarea[placeholder*="comment" i]') ||
                            document.querySelector('textarea[aria-label*="comment" i]') ||
                            document.querySelector('textarea');
        
        let buttons = [];
        if (commentInput) {
          // Find buttons that are siblings or in the same container as the comment input
          const container = commentInput.closest('form, div, section');
          if (container) {
            buttons = Array.from(container.querySelectorAll('button, [role="button"]'));
          }
        }
        
        // Fallback to all buttons if no container found
        if (buttons.length === 0) {
          buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        }
        
        const buttonTexts = buttons.map(btn => btn.textContent?.trim().toLowerCase() || '');
        
        for (let i = 0; i < buttons.length; i++) {
          const text = buttonTexts[i];
          const button = buttons[i];
          
          // Look for "post" button specifically, and ensure it's not disabled
          if (text === 'post' && !button.disabled && button.offsetHeight > 0) {
            button.click();
            return { found: true, text: text, totalButtons: buttons.length, context: 'comment-area' };
          }
        }
        return { found: false, buttonTexts: buttonTexts.slice(0, 10), totalButtons: buttons.length, context: 'comment-area' };
      });
      
      if (buttonInfo.found) {
        console.log(`💬 Found and clicked "${buttonInfo.text}" button (${buttonInfo.totalButtons} buttons total)`);
        submitted = true;
      } else {
        console.log(`💬 No Post/Share button found. Available buttons: [${buttonInfo.buttonTexts.join(', ')}] (${buttonInfo.totalButtons} total)`);
      }
    }

    // Method 2: Try Enter key if button not found
    if (!submitted) {
      console.log(`💬 Submit button not found, trying Enter key...`);
      await page.keyboard.press('Enter');
      submitted = true;
    }

    await sleep(3000);

    // Verify comment was posted by checking if input is cleared or comment appears
    console.log(`💬 Verifying comment was posted...`);
    const verificationResult = await page.evaluate((commentText) => {
      // Check if comment input is cleared
      const input = document.querySelector('textarea[placeholder*="comment" i]') ||
                   document.querySelector('textarea[aria-label*="comment" i]') ||
                   document.querySelector('textarea');
      
      const inputCleared = input && input.value.trim() === '';
      const inputValue = input ? input.value.trim() : 'no-input-found';
      
      // Look more specifically for comments in comment sections
      const commentSections = document.querySelectorAll('[role="button"] span, article span, li span');
      let commentFound = false;
      
      for (const span of commentSections) {
        if (span.textContent && span.textContent.includes(commentText)) {
          commentFound = true;
          break;
        }
      }
      
      return {
        inputCleared,
        inputValue,
        commentFound,
        totalCommentElements: commentSections.length,
        success: inputCleared || commentFound
      };
    }, comment);
    
    console.log(`💬 Verification result:`, {
      inputCleared: verificationResult.inputCleared,
      inputValue: verificationResult.inputValue,
      commentFound: verificationResult.commentFound,
      totalElements: verificationResult.totalCommentElements
    });
    
    const commentPosted = verificationResult.success;

    if (commentPosted) {
      console.log(`✅ Comment posted successfully: ${postUrl}`);
      
      // No need to mark in cache - we detect comments directly from the page
      
      console.log(`💬 ===== INSTAGRAM COMMENT END: SUCCESS =====`);
      return { success: true, postUrl };
    } else {
      throw new Error('Comment verification failed - comment may not have been posted');
    }

  } catch (error) {
    console.error(`❌ Error commenting on Instagram post ${postUrl}:`, error.message);
    console.log(`💬 ===== INSTAGRAM COMMENT END: ERROR =====`);
    throw error;
  }
}
