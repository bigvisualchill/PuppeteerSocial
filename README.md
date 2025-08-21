# Instagram Automation Bot 🤖

A sophisticated Instagram automation tool built with Node.js, Puppeteer, and OpenAI integration. This bot can automatically discover posts, like them, and leave AI-generated comments based on hashtag searches.

## 🚀 Features

- **🎯 Auto-Comment**: Automatically finds posts and leaves intelligent comments using OpenAI
- **❤️ Auto-Like**: Can like posts before commenting
- **🔍 Smart Discovery**: Searches hashtags and finds new posts progressively
- **🧠 AI Integration**: Uses OpenAI GPT for generating contextually relevant comments
- **🌐 Web Interface**: Modern web UI for easy control and monitoring
- **📊 Progress Tracking**: Real-time progress monitoring and detailed logging
- **🔐 Session Management**: Secure session handling for multiple accounts
- **🛡️ Anti-Detection**: Uses Puppeteer Extra Stealth Plugin to avoid detection

## 📁 Project Structure

```
📦 Instagram Automation Bot
├── 📄 bot.js                 # Main bot logic and action runner
├── 📄 server.js             # Express server for web interface
├── 📄 instagram-functions.js # Instagram-specific functions
├── 📄 index.js              # Server entry point
├── 📄 package.json          # Dependencies and scripts
├── 📄 start.command         # Mac startup script
├── 📄 env-example.txt       # Environment variables template
├── 📄 README.md             # This file
├── 📁 public/               # Web interface files
│   └── 📄 index.html       # Main web UI
├── 📁 utils/               # Utility functions
│   ├── 📄 igHasMyComment.js   # Comment detection and caching
│   ├── 📄 commented-posts.json # Comment tracking database
│   └── 📄 igHasMyComment.js.backup
└── 📁 .sessions/           # Stored browser sessions
```

## 🏗️ Architecture

### Core Components

#### 1. **Bot Engine (`bot.js`)**
- **Purpose**: Central orchestration engine for all automation actions
- **Key Functions**:
  - `runAction()`: Main action dispatcher
  - `generateAIComment()`: OpenAI integration for comment generation
  - `getPostContent()`: Extract content from Instagram posts
  - Session management and browser control

#### 2. **Instagram Functions (`instagram-functions.js`)**
- **Purpose**: Instagram-specific operations
- **Key Functions**:
  - `discoverInstagramPosts()`: Find posts by hashtag search
  - `ensureInstagramLoggedIn()`: Handle Instagram authentication
  - `instagramLike()`: Like posts with multiple fallback methods
  - `instagramComment()`: Post comments on Instagram

#### 3. **Web Server (`server.js`)**
- **Purpose**: Provides REST API and serves web interface
- **Features**:
  - `/run` endpoint for triggering automation
  - `/health` endpoint for status checking
  - WebSocket progress streaming
  - Static file serving

#### 4. **Comment Detection (`utils/igHasMyComment.js`)**
- **Purpose**: Track and detect already-commented posts
- **Key Functions**:
  - `hasMyCommentAndCache()`: Check if user commented on post
  - `debugCommentDetection()`: Debug comment detection
  - Caching system to avoid duplicate comments

## 🛠️ Build & Setup

### Prerequisites
- **Node.js** 16+ (tested with Node.js 18, 20)
- **npm** or **yarn**
- **Git** for version control

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/bigvisualchill/PuppeteerSocial.git
   cd PuppeteerSocial
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Configure environment**:
   ```bash
   cp env-example.txt .env
   # Edit .env with your settings
   ```

4. **Start the server**:
   ```bash
   # Option 1: Using npm
   npm start

   # Option 2: Using the startup script
   ./start.command
   ```

5. **Access the web interface**:
   Open `http://localhost:3000` in your browser

### Environment Configuration

```bash
# .env file
# OpenAI API Key (required for AI comments)
OPENAI_API_KEY=your_openai_api_key_here

# OpenAI Assistant ID (optional)
OPENAI_ASSISTANT_ID=your_assistant_id_here

# Server Port (optional, defaults to 3000)
PORT=3000
```

## 🚀 Usage

### Web Interface
1. Navigate to `http://localhost:3000`
2. Select your Instagram account from the session dropdown
3. Configure your automation:
   - **Action**: Choose "Auto Comment"
   - **Platform**: Instagram
   - **Hashtag**: Enter hashtag to search (e.g., "nature")
   - **Max Posts**: Number of posts to comment on
   - **Comment**: Manual comment text
   - **Use AI**: Enable AI-generated comments
   - **Like Posts**: Enable liking before commenting
4. Click "Start Action" and monitor progress

### API Usage

#### Trigger Auto-Comment
```bash
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{
    "action": "auto-comment",
    "platform": "instagram",
    "sessionName": "your_session_name",
    "searchCriteria": {"hashtag": "nature"},
    "maxPosts": 5,
    "useAI": true,
    "comment": "Great post!",
    "likePost": true
  }'
```

#### Check Session Status
```bash
curl -X POST http://localhost:3000/run \
  -H "Content-Type: application/json" \
  -d '{
    "action": "check-session",
    "platform": "instagram",
    "sessionName": "your_session_name"
  }'
```

## 🔧 Key Features Explained

### Smart Post Discovery
- **Progressive Search**: Continuously scrolls and discovers new posts
- **Duplicate Prevention**: Tracks discovered posts to avoid repetition
- **Intelligent Stopping**: Only stops when truly no more posts are available

### AI Comment Generation
- **Contextual Comments**: Analyzes post content for relevant responses
- **Fallback System**: Falls back to manual comment if AI fails
- **Custom Assistant**: Uses OpenAI Assistants API for consistent personality

### Like Functionality
- **Multiple Detection Methods**: 7+ different selectors for like buttons
- **Comprehensive Debugging**: Detailed logs when likes fail
- **Fallback Methods**: Multiple click strategies for reliability

### Session Management
- **Secure Storage**: Encrypted browser sessions
- **Multi-Account**: Support for multiple Instagram accounts
- **Automatic Recovery**: Handles session expiration gracefully

## 🐛 Troubleshooting

### Common Issues

#### 1. "Module not found" errors
- Run `npm install` to install missing dependencies
- Check that all required files are present

#### 2. Auto-comment stops prematurely
- Recent fixes removed artificial limits
- Bot now only stops for valid reasons (see "Recent Fixes" below)

#### 3. Likes not working
- Enhanced debugging shows exactly what's happening
- Multiple fallback methods implemented
- Check console logs for detailed like status information

#### 4. Instagram login issues
- Ensure cookies are properly saved
- Check for Instagram rate limiting
- Verify account credentials

### Debug Mode
Enable detailed logging by checking the console output. The bot provides comprehensive debug information including:
- Post discovery progress
- Like button detection results
- Comment posting status
- Error details with suggested fixes

## 🔄 Recent Fixes & Improvements

### v2.0+ (Latest)
- ✅ **Fixed Search Limits**: Removed artificial attempt limits causing premature stopping
- ✅ **Enhanced Post Discovery**: Fixed repeated same posts bug - now finds new content progressively
- ✅ **Improved Like Functionality**: Added comprehensive like button detection with 7+ selectors
- ✅ **Navigation Optimization**: Eliminated redundant navigation between like and comment functions
- ✅ **Better Error Handling**: Added detailed debugging and multiple fallback methods
- ✅ **Valid Stopping Logic**: Now only stops for legitimate reasons:
  - No posts exist under search term
  - Search term exhausted (scrolled to bottom)
  - Target number of comments reached

### Previous Versions
- Added progress monitoring and real-time updates
- Implemented AI comment generation with OpenAI integration
- Added session management and multi-account support
- Created modern web interface with queue system

## 📈 Performance Considerations

- **Memory Usage**: Bot maintains session data and discovered post cache
- **Rate Limiting**: Respects Instagram's rate limits with built-in delays
- **Resource Management**: Automatic browser cleanup and context management
- **Scalability**: Designed to handle multiple simultaneous sessions

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes and test thoroughly
4. Commit changes: `git commit -am 'Add new feature'`
5. Push to branch: `git push origin feature-name`
6. Submit a pull request

## 📄 License

This project is licensed under the MIT License. See LICENSE file for details.

## ⚠️ Disclaimer

This tool is for educational and research purposes only. Users are responsible for complying with Instagram's terms of service and applicable laws. The authors are not responsible for any misuse of this software.

## 🆘 Support

For issues and questions:
1. Check the troubleshooting section above
2. Review the console logs for detailed error information
3. Check GitHub issues for similar problems
4. Create a new issue with detailed reproduction steps

---

**Built with ❤️ using:**
- **Puppeteer** - Browser automation
- **Puppeteer Extra Stealth** - Anti-detection
- **OpenAI API** - AI comment generation
- **Express.js** - Web server
- **Node.js** - Runtime environment