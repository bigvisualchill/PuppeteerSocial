import 'dotenv/config';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { 
  ensureInstagramLoggedIn, 
  instagramLike, 
  instagramComment, 
  discoverInstagramPosts,
  resetDiscoveryState 
} from './instagram-functions.js';
import { hasMyCommentAndCache, debugCommentDetection } from './utils/igHasMyComment.js';

puppeteer.use(StealthPlugin());

// cross-runtime sleep (works in any Puppeteer version)
export const sleep = (ms) => new Promise(res => setTimeout(res, ms));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper function to click elements by text content
export async function tryClickByText(page, texts = []) {
  for (const t of texts) {
    try {
      // Use page.evaluate to find and click elements by text
      const clicked = await page.evaluate((text) => {
        const elements = document.querySelectorAll('button, a, div, span');
        for (const el of elements) {
          const elText = (el.textContent || '').trim().toLowerCase();
          if (elText.includes(text.toLowerCase())) {
            el.click();
            return true;
          }
        }
        return false;
      }, t);
      
      if (clicked) {
        console.log(`✅ Clicked element with text: "${t}"`);
        await sleep(500);
        return true;
      }
    } catch (error) {
      console.log(`Failed to click element with text "${t}": ${error.message}`);
    }
  }
  return false;
}

// Initialize OpenAI client (optional)
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// Global browser instance for headful mode
let globalBrowser = null;
let platformContexts = new Map(); // platform -> { context, page }

// Session management functions
function getSessionFilePath(platform, sessionName) {
  const sessionsDir = path.join(__dirname, '.sessions');
  
  // If sessionName already contains platform prefix, don't double-prefix
  // Handle both formats: "platform_username" and "username"
  let cleanSessionName = sessionName;
  if (sessionName.includes('_') && sessionName.startsWith(platform + '_')) {
    cleanSessionName = sessionName.substring(platform.length + 1); // Remove "platform_"
  }
  
  return { sessionsDir, sessionPath: path.join(sessionsDir, `${platform}-${cleanSessionName}.json`) };
}

async function saveSession(page, platform, sessionName = 'default', metadata = {}) {
  const { sessionsDir, sessionPath } = getSessionFilePath(platform, sessionName);
  await fs.mkdir(sessionsDir, { recursive: true });
  const cookies = await page.cookies();
  const storage = await page.evaluate(() => {
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key != null) ls[key] = localStorage.getItem(key);
    }
    const ss = {};
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key != null) ss[key] = sessionStorage.getItem(key);
    }
    return { localStorage: ls, sessionStorage: ss };
  });
  
  // Include metadata (like assistantId) in session file
  const sessionData = { 
    cookies, 
    storage, 
    metadata: {
      ...metadata,
      savedAt: new Date().toISOString(),
      platform
    }
  };
  
  await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2), 'utf8');
  console.log(`Session saved with metadata:`, metadata);
}

// Helper function to get Assistant ID from session
async function getSessionAssistantId(platform, sessionName) {
  try {
    const { sessionPath } = getSessionFilePath(platform, sessionName);
    const data = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
    return data.metadata?.assistantId || null;
  } catch (error) {
    console.log(`Could not load assistant ID from session: ${error.message}`);
    return null;
  }
}

async function loadSession(page, platform, sessionName = 'default') {
  const { sessionPath } = getSessionFilePath(platform, sessionName);
  console.log(`Loading session from: ${sessionPath}`);
  try {
    const data = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
    console.log(`Session data loaded - cookies: ${data.cookies?.length || 0}, localStorage: ${Object.keys(data.storage?.localStorage || {}).length}, sessionStorage: ${Object.keys(data.storage?.sessionStorage || {}).length}`);
    
    // Log assistant ID if available
    if (data.metadata?.assistantId) {
      console.log(`🤖 Session Assistant ID: ${data.metadata.assistantId}`);
    }
    
    let cookiesLoaded = false;
    if (Array.isArray(data.cookies) && data.cookies.length > 0) {
      await page.setCookie(...data.cookies);
      console.log(`Set ${data.cookies.length} cookies`);
      cookiesLoaded = true;
    } else {
      console.log('No cookies to set');
    }
    
    try {
      await page.evaluate(storage => {
        if (storage?.localStorage) {
          for (const [k, v] of Object.entries(storage.localStorage)) {
            localStorage.setItem(k, v);
          }
        }
        if (storage?.sessionStorage) {
          for (const [k, v] of Object.entries(storage.sessionStorage)) {
            sessionStorage.setItem(k, v);
          }
        }
      }, data.storage);
      console.log('Storage data loaded');
    } catch (e) {
      console.log('Could not load storage data:', e.message);
    }
    
    return data;
  } catch (error) {
    console.log(`Session not found: ${sessionPath}`, error.message);
    return null;
  }
}

async function launchBrowser(headful, platform = null) {
  let browser, page;
  
          if (headful) {
    // For headful mode, always create a new browser instance
      browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });
    page = await browser.newPage();
    } else {
    // For headless mode, use simple approach
    if (!globalBrowser) {
      globalBrowser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage'
        ]
      });
    }
    
    browser = globalBrowser;
      page = await browser.newPage();
  }
  
    return { browser, page };
}

async function setupPage(page, headful) {
  // Set user agent to look more human
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  // Set viewport if not headful (headful uses defaultViewport: null)
  if (!headful) {
    await page.setViewport({ width: 1366, height: 768 });
  }

  // Allow all resources for proper page rendering
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    // Only block heavy media files, but allow stylesheets and fonts for proper rendering
    if (resourceType === 'media' || resourceType === 'websocket') {
      req.abort();
      } else {
      req.continue();
    }
  });
}

// AI comment generation
async function generateAIComment(postContent, sessionAssistantId = null) {
  if (!openai) {
    throw new Error('OpenAI API key not configured');
  }

  try {
    console.log('🤖 Generating AI comment...');
    
    let assistantId = sessionAssistantId;
    if (!assistantId) {
      assistantId = process.env.OPENAI_ASSISTANT_ID;
    }

    if (!assistantId) {
      throw new Error('No OpenAI Assistant ID found in session or environment');
    }

    const thread = await openai.beta.threads.create();

    // Create message with post content
    await openai.beta.threads.messages.create(thread.id, {
      role: "user",
      content: `Please write a brief, engaging comment for this social media post. Keep it natural, friendly, and under 50 words. Post content: "${postContent}"`
    });

    const run = await openai.beta.threads.runs.createAndPoll(thread.id, {
      assistant_id: assistantId,
    });

    if (run.status === 'completed') {
    const messages = await openai.beta.threads.messages.list(thread.id, { limit: 20 });
      const assistantMessage = messages.data.find(msg => msg.role === 'assistant');
      
      if (assistantMessage && assistantMessage.content[0]?.text?.value) {
        const comment = assistantMessage.content[0].text.value.trim();
        console.log(`🤖 AI generated comment: "${comment}"`);
        return comment;
      }
    }

    throw new Error(`AI comment generation failed with status: ${run.status}`);
  } catch (error) {
    console.error('❌ AI comment generation error:', error.message);
    throw error;
  }
}

// Instagram content extraction
async function getPostContent(page, postUrl, platform) {
  console.log(`📖 Extracting post content from: ${postUrl}`);
  
  try {
    await page.goto(postUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(2000);

    // Instagram content extraction
    const instagramText = await page.evaluate(() => {
      console.log('🔍 Starting Instagram content extraction...');
      
      // Try multiple selectors for Instagram post text
      const selectors = [
        'article h1', // Instagram post text is often in h1
        'article div[data-testid="post-text"]',
        'article span[dir="auto"]', // Instagram uses dir="auto" for text
        'div[role="button"] span', // Sometimes text is in clickable spans
        'article div[style*="line-height"] span', // Text often has specific line-height
        'article span:not([aria-label]):not([role])', // Text spans without special attributes
        'article div > span', // Direct child spans of divs
        'meta[property="og:description"]' // Fallback to meta description
      ];

      let bestText = '';
      let bestScore = 0;

      for (const selector of selectors) {
        try {
          if (selector === 'meta[property="og:description"]') {
            const meta = document.querySelector(selector);
            if (meta) {
              const content = meta.getAttribute('content') || '';
              if (content.length > bestText.length && content.length > 10) {
                bestText = content;
                bestScore = content.length;
                console.log(`📖 Found content via meta: "${content.slice(0, 100)}..."`);
              }
            }
            continue;
          }

        const elements = document.querySelectorAll(selector);
        for (const el of elements) {
            const text = (el.textContent || '').trim();
            
            // Skip if too short or looks like UI text
            if (text.length < 10) continue;
            if (text.toLowerCase().includes('like') && text.length < 20) continue;
            if (text.toLowerCase().includes('comment') && text.length < 20) continue;
            if (text.toLowerCase().includes('share') && text.length < 20) continue;
            if (text.toLowerCase().includes('follow') && text.length < 20) continue;
            
            // Score based on length and content characteristics
            let score = text.length;
            if (text.includes('#')) score += 20; // Hashtags are good indicators
            if (text.includes('@')) score += 10; // Mentions too
            if (text.includes('.') || text.includes('!') || text.includes('?')) score += 15; // Punctuation
            if (text.split(' ').length > 5) score += 10; // Multiple words
            
            if (score > bestScore) {
              bestText = text;
              bestScore = score;
              console.log(`📖 Found better content (score ${score}): "${text.slice(0, 100)}..."`);
            }
          }
        } catch (e) {
          console.log(`Selector failed: ${selector}`);
        }
      }

      console.log(`📖 Final Instagram content: "${bestText.slice(0, 100)}${bestText.length > 100 ? '...' : ''}"`);
      return bestText;
    });

    console.log(`📖 Instagram post content extracted: "${(instagramText || '').slice(0, 140)}${instagramText && instagramText.length > 140 ? '…' : ''}"`);
    return instagramText || '';

  } catch (error) {
    console.error('❌ Error extracting post content:', error.message);
          return '';
        }
}

// Session status checking
async function checkSessionStatus(page, platform, sessionName = 'default') {
  console.log(`🔍 Checking session status for ${platform}...`);
  
  try {
    if (platform === 'instagram') {
      await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
      await sleep(2000);
      
    const currentUrl = page.url();
      console.log(`Current URL: ${currentUrl}`);
      
      // Check for login indicators
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
      
      const loginFormSelectors = [
        'input[name="username"]',
        'input[name="password"]'
      ];
      
      const hasLoginIndicators = await page.evaluate((selectors) => {
        return selectors.some(selector => document.querySelector(selector));
      }, loginIndicators);
      
      const hasLoginForm = await page.evaluate((selectors) => {
        return selectors.some(selector => {
        const element = document.querySelector(selector);
          if (!element) return false;
          // Check if element is visible
          const style = window.getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && element.offsetHeight > 0;
        });
      }, loginFormSelectors);
      
      const onLoginPage = currentUrl.includes('/accounts/login/') || currentUrl.includes('/accounts/emailsignup/');
      const titleIndicatesLogin = (await page.title()).toLowerCase().includes('login');
      
      console.log(`=== Instagram Login Status Check ===`);
      console.log(`Checking login status on URL: ${currentUrl}`);
      console.log(`Page title: ${await page.title()}`);
      console.log(`Login status determination:`);
      console.log(`  - Has login indicators: ${hasLoginIndicators}`);
      console.log(`  - Has login form: ${hasLoginForm}`);
      console.log(`  - On login page: ${onLoginPage}`);
      console.log(`  - Title indicates login: ${titleIndicatesLogin}`);
      
      const isLoggedIn = hasLoginIndicators && !hasLoginForm && !onLoginPage && !titleIndicatesLogin;
      console.log(`  - Final result: ${isLoggedIn}`);
      
      return {
        isLoggedIn,
        reason: isLoggedIn ? 'logged-in' : 'logged-out',
        details: {
          hasLoginIndicators,
          hasLoginForm,
          onLoginPage,
          titleIndicatesLogin,
          currentUrl
        }
      };
    }
    
    return { isLoggedIn: false, reason: 'unsupported-platform' };
  } catch (error) {
    console.error(`❌ Error checking session status: ${error.message}`);
    return { isLoggedIn: false, reason: 'error', error: error.message };
  }
}

// Logout function
async function logout(page, platform, sessionName = 'default') {
  try {
    console.log(`🚪 Logging out of ${platform}...`);
    
    if (platform === 'instagram') {
      await page.goto('https://www.instagram.com/', { waitUntil: 'networkidle2' });
          await sleep(2000);
          
      // Clear cookies and localStorage
      await page.evaluate(() => {
        localStorage.clear();
        sessionStorage.clear();
      });
      await page.deleteCookie(...await page.cookies());
      
      // Delete session file
      const { sessionPath } = getSessionFilePath(platform, sessionName);
      try {
        await fs.unlink(sessionPath);
        console.log(`✅ Session file deleted: ${sessionPath}`);
          } catch (error) {
        console.log(`⚠️ Could not delete session file: ${error.message}`);
      }
      
      return { ok: true, message: 'Logged out successfully' };
    }
    
    return { ok: false, message: 'Unsupported platform' };
      } catch (error) {
    console.error('❌ Logout error:', error.message);
    return { ok: false, message: error.message };
  }
}

// Cleanup function for corrupted browser contexts
async function cleanupBrowserContexts() {
  console.log('🧹 Cleaning up browser contexts...');
  
  for (const [platform, context] of platformContexts.entries()) {
    try {
      await context.context.close();
      console.log(`✅ Closed context for ${platform}`);
  } catch (error) {
      console.log(`⚠️ Failed to close context for ${platform}:`, error.message);
    }
  }
  
  platformContexts.clear();
  
  if (globalBrowser) {
    try {
      await globalBrowser.close();
      globalBrowser = null;
      console.log('✅ Closed global browser');
  } catch (error) {
      console.log('⚠️ Failed to close global browser:', error.message);
      // Force reset even if close fails
      globalBrowser = null;
    }
  }
  
  // Kill any remaining Chrome processes that might be hanging
  try {
    const { spawn } = await import('child_process');
    spawn('pkill', ['-f', 'chrome'], { stdio: 'ignore' });
    console.log('🔪 Killed any hanging Chrome processes');
  } catch (error) {
    console.log('⚠️ Could not kill Chrome processes:', error.message);
  }
}

// Main action runner
export async function runAction(options) {
  const {
    action,
    platform,
    username,
    password,
    sessionName = 'default',
    maxPosts = 5,
    hashtag,
    keywords,
    searchCriteria,
    comment,
    useAI = false,
    headful = false,
    likePost = false,
    reportProgress = () => {}
  } = options;
  
  console.log(`🚀 Running action: ${action} on ${platform}`);

  let browser, page;
  
  try {
    ({ browser, page } = await launchBrowser(headful, platform));
    await setupPage(page, headful);
    
    if (!platform || platform !== 'instagram') {
      return { ok: false, message: 'Only Instagram platform is supported' };
    }

    // Load session if it exists
      await loadSession(page, platform, sessionName);

    // Use searchCriteria if provided, otherwise fall back to hashtag/keywords
    const finalSearchCriteria = searchCriteria || { hashtag, keywords };

      if (action === 'login') {
        try {
        const sessionAssistantId = options.assistantId || null;
        
        if (sessionAssistantId) {
          await ensureInstagramLoggedIn(page, { username, password });
          await saveSession(page, platform, sessionName, { assistantId: sessionAssistantId });
          return { ok: true, message: 'Instagram login successful and session saved with Assistant ID.' };
        } else {
          return { ok: false, message: 'Instagram login failed: Assistant ID is required.' };
        }
        } catch (error) {
          return { ok: false, message: `Instagram login failed: ${error.message}` };
        }
      }

    // Ensure logged in for other actions
      await ensureInstagramLoggedIn(page, { username, password });
      
      if (action === 'discover') {
      const posts = await discoverInstagramPosts(page, finalSearchCriteria, maxPosts);
        return { ok: true, message: `Found ${posts.length} Instagram posts`, posts };
      }
      
      if (action === 'auto-comment') {
        console.log(`\n🎯 ACTION: Auto-commenting on Instagram`);
      console.log(`🎯 TARGET: ${maxPosts} comments`);
      console.log(`🎯 SEARCH: ${JSON.stringify(finalSearchCriteria)}`);
      console.log(`🎯 AI: ${useAI ? 'Enabled' : 'Disabled'}`);
      console.log(`🎯 LIKE: ${likePost ? 'Yes' : 'No'}`);
      
      // Reset discovery state for new search session
      resetDiscoveryState();

        reportProgress('🔍 Starting Instagram search...', { 
        action: 'auto-comment', 
        status: 'searching',
          platform: 'Instagram',
        target: maxPosts,
        completed: 0
      });

              const sessionAssistantId = await getSessionAssistantId(platform, sessionName);

      let successfulComments = 0;
      let attempts = 0;
      let consecutiveEmptyBatches = 0;
      const maxConsecutiveEmptyBatches = 5; // Only stop after multiple consecutive empty batches
      
      while (successfulComments < maxPosts) {
        const batchSize = Math.min(10, maxPosts * 2); // Get more posts than needed
        console.log(`\n📦 BATCH ${Math.floor(attempts/10) + 1}: Fetching ${batchSize} posts...`);
        
        try {
          const posts = await discoverInstagramPosts(page, finalSearchCriteria, batchSize);
          
          if (posts.length === 0) {
            consecutiveEmptyBatches++;
            console.log(`❌ No posts found in this batch (${consecutiveEmptyBatches}/${maxConsecutiveEmptyBatches} consecutive empty batches)`);
            
            if (consecutiveEmptyBatches >= maxConsecutiveEmptyBatches) {
              console.log(`🛑 Stopping: ${maxConsecutiveEmptyBatches} consecutive empty batches - no more posts available under this search term`);
              break; // VALID REASON: No posts existing under the search term OR search term exhausted
            }
            
            continue; // Try again
          } else {
            consecutiveEmptyBatches = 0; // Reset counter when we find posts
          }
          
          for (const postUrl of posts) {
            if (successfulComments >= maxPosts) break;
          attempts++;
            
            // Report progress for each Instagram post
            reportProgress(`📄 Processing Instagram post ${attempts}...`, {
              action: 'auto-comment',
              status: 'processing',
              platform: 'Instagram',
              target: maxPosts,
              completed: successfulComments,
              currentPost: postUrl
            });
            
            try {
              console.log(`\n📄 POST ${attempts}: ${postUrl}`);
              
              // Get post content for AI or display
              const instagramPostContent = await getPostContent(page, postUrl, platform);
              console.log(`📄 POST CONTENT: "${instagramPostContent.slice(0, 80)}${instagramPostContent.length > 80 ? '...' : ''}"`);

              // Check content quality
              const wordCount = instagramPostContent.trim().split(/\s+/).filter(word => word.length > 0).length;
              console.log(`📊 Content analysis: ${wordCount} words`);

              if (wordCount < 3) {
                console.log(`⚠️ Skipping post with minimal content (${wordCount} words)`);
                continue;
              }

              // Check for video content and skip if configured to do so
              if (instagramPostContent.toLowerCase().includes('video') || 
                  instagramPostContent.toLowerCase().includes('watch') ||
                  instagramPostContent.toLowerCase().includes('play')) {
                
                // Look for video elements in Instagram
                const hasVideo = await page.evaluate(() => {
                  return document.querySelector('video') !== null;
                });

                if (hasVideo) {
                  console.log(`🎥 Skipping video post: "${instagramPostContent.slice(0, 50)}..."`);
                continue;
              }
              }

              // Check if we already commented on this post
              const alreadyCommented = await hasMyCommentAndCache({ page, username, postUrl });
              
              if (alreadyCommented) {
                console.log(`⏭️ Skipping already commented post`);
                continue;
              }
              
              // Determine final comment text
              let finalComment;
              if (useAI && instagramPostContent.trim()) {
                try {
                  finalComment = await generateAIComment(instagramPostContent, sessionAssistantId);
                } catch (aiError) {
                  console.log(`⚠️ AI comment generation failed, using manual comment: ${aiError.message}`);
                  finalComment = comment || 'Great post! 👍';
                }
              } else {
                finalComment = comment || 'Great post! 👍';
              }
              
              console.log(`💬 Using comment: "${finalComment}"`);

              // Like post if requested
              let likedSuccessfully = false;
            if (likePost) {
                try {
                  console.log(`❤️ Attempting to like post...`);
                  console.log(`⚠️ WARNING: Instagram has strong anti-bot measures for likes. This may not work reliably.`);
                  const likeResult = await instagramLike(page, postUrl);
                  if (likeResult) {
                    console.log(`✅ Post liked successfully`);
                    likedSuccessfully = true;
                  } else {
                    console.log(`❌ Like failed for post: ${postUrl}`);
                    console.log(`ℹ️ This is normal - Instagram often blocks automated likes. Comments will still work.`);
                  }
              } catch (likeError) {
                  console.log(`⚠️ Like failed but continuing with comment: ${likeError.message}`);
                  console.log(`ℹ️ This is normal - Instagram often blocks automated likes. Comments will still work.`);
                }
              }

              // Post comment (pass flag to avoid redundant navigation)
              const commentResult = await instagramComment(page, postUrl, finalComment, username, likedSuccessfully);
              
              // Only count as success if comment was actually posted (not skipped)
              if (commentResult && commentResult.skipped) {
                console.log(`⏭️ SKIPPED: ${commentResult.reason}`);
                continue; // Skip to next post without incrementing counter
              }
              
              // Check if comment actually succeeded
              if (commentResult && !commentResult.success) {
                console.log(`❌ COMMENT FAILED: ${commentResult.reason}`);
                continue; // Skip to next post without incrementing counter
              }
              
              // No need to update cache - we detect comments directly from the page
              
              successfulComments++;
              
              // Report success progress for Instagram
              reportProgress(`✅ Instagram comment posted! (${successfulComments}/${maxPosts})`, {
                action: 'auto-comment',
                status: 'success',
                platform: 'Instagram',
                target: maxPosts,
                completed: successfulComments,
                comment: finalComment
              });

              console.log(`✅ SUCCESS ${successfulComments}/${maxPosts}: Comment posted!`);

              if (successfulComments >= maxPosts) {
                console.log(`🎉 Target reached! Posted ${successfulComments} comments.`);
              break;
              }

              // Delay between posts
              const delay = Math.random() * 3000 + 2000; // 2-5 seconds
              console.log(`⏱️ Waiting ${Math.round(delay/1000)}s before next post...`);
              await sleep(delay);

          } catch (error) {
              console.error(`❌ Error processing post ${postUrl}:`, error.message);
                    continue;
                  }
                }
                
          if (successfulComments >= maxPosts) break;
              
            } catch (error) {
          console.error(`❌ Error in batch processing:`, error.message);
            break;
          }
      }

      reportProgress('🎉 Instagram completed!', {
        action: 'auto-comment',
        status: 'completed',
        platform: 'Instagram',
        target: maxPosts,
        completed: successfulComments
      });

      const message = `Instagram auto-comment completed: ${successfulComments}/${maxPosts} successful comments`;
      console.log(`\n🎉 ${message}`);
      
      return { ok: true, message, results: { successful: successfulComments, total: attempts } };
      }

      if (action === 'like') {
      const posts = await discoverInstagramPosts(page, finalSearchCriteria, maxPosts);
          const results = [];
          
          for (const postUrl of posts) {
            try {
          await instagramLike(page, postUrl);
              results.push({ url: postUrl, success: true });
          await sleep(Math.random() * 2000 + 1000); // 1-3 second delay
            } catch (error) {
          console.error(`Failed to like post ${postUrl}:`, error.message);
              results.push({ url: postUrl, success: false, error: error.message });
            }
          }
          
      return { ok: true, message: `Liked ${results.filter(r => r.success).length} Instagram posts`, results };
        }
      
      if (action === 'comment') {
      const url = options.url;
        const sessionAssistantId = await getSessionAssistantId(platform, sessionName);
      const finalComment = useAI ? await generateAIComment(await getPostContent(page, url, platform), sessionAssistantId) : comment;
      
      await instagramComment(page, url, finalComment);
      return { ok: true, message: 'Comment posted successfully' };
    }

    if (action === 'check-session') {
      try {
        const status = await checkSessionStatus(page, platform, sessionName);
        const message = status.isLoggedIn ? 'Session is active' : 'Session is not active';
        return { ok: true, status, message };
      } catch (sessionError) {
        console.error('❌ Check session failed:', sessionError.message);
        return { ok: false, message: `Session check failed: ${sessionError.message}` };
      }
    }

    if (action === 'logout') {
      return await logout(page, platform, sessionName);
    }

    // Cache-related actions removed - now using direct comment detection

    return { ok: false, message: 'Unknown action' };

        } catch (error) {
    console.error('❌ Action failed:', error.message);
    return { ok: false, message: error.message };
  } finally {
    if (headful && browser) {
      // In headful mode, close the browser
          await browser.close();
    }
    // For headless mode, keep the global browser open for reuse
  }
}

// Export for CLI usage
export default { runAction };
export { cleanupBrowserContexts };
