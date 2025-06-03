/**
 * Content Script for Video Recap Assistant
 * Monitors audio/video elements and extracts transcripts when paused
 */

class VideoRecapMonitor {
  constructor() {
    this.monitoredElements = new Set();
    this.summaryCache = new Map();
    this.currentSummary = null;
    this.overlayContainer = null;
    
    this.init();
  }

  init() {
    console.log('Video Recap Assistant: Initializing content script');
    
    // Monitor existing media elements
    this.scanForMediaElements();
    
    // Set up mutation observer for dynamically added media
    this.setupMutationObserver();
    
    // Listen for messages from popup/background
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      this.handleMessage(message, sender, sendResponse);
      return true; // Keep message channel open for async response
    });
  }

  /**
   * Scan the page for existing audio/video elements
   */
  scanForMediaElements() {
    const mediaElements = document.querySelectorAll('audio, video');
    console.log(`Found ${mediaElements.length} media elements`);
    
    mediaElements.forEach(element => this.attachMediaListeners(element));
  }

  /**
   * Set up mutation observer to catch dynamically added media elements
   */
  setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            // Check if the added node is a media element
            if (node.tagName === 'AUDIO' || node.tagName === 'VIDEO') {
              this.attachMediaListeners(node);
            }
            
            // Check for media elements within the added node
            const mediaElements = node.querySelectorAll?.('audio, video');
            mediaElements?.forEach(element => this.attachMediaListeners(element));
          }
        });
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  /**
   * Attach event listeners to a media element
   */
  attachMediaListeners(element) {
    // Avoid duplicate listeners
    if (this.monitoredElements.has(element)) return;
    
    this.monitoredElements.add(element);
    console.log('Monitoring new media element:', element.tagName);

    // Listen for pause events
    element.addEventListener('pause', () => {
      this.handleMediaPause(element);
    });

    // Clean up when element is removed
    element.addEventListener('emptied', () => {
      this.monitoredElements.delete(element);
    });
  }

  /**
   * Handle media pause event
   */
  async handleMediaPause(element) {
    console.log('Media paused, extracting transcript...');
    
    // Show loading indicator
    this.showLoadingIndicator();
    
    try {
      // Extract transcript from DOM
      const transcript = this.extractTranscript(element);
      
      if (!transcript) {
        this.showFallbackMessage();
        return;
      }

      // Check cache first
      const cacheKey = this.generateCacheKey(transcript);
      if (this.summaryCache.has(cacheKey)) {
        console.log('Using cached summary');
        this.displaySummary(this.summaryCache.get(cacheKey));
        return;
      }

      // Generate summary
      const summary = await this.generateSummary(transcript);
      
      if (summary) {
        // Cache the summary
        this.summaryCache.set(cacheKey, summary);
        this.displaySummary(summary);
        
        // Store in extension storage for popup access
        this.storeSummary(summary, transcript);
      } else {
        this.showErrorMessage();
      }
      
    } catch (error) {
      console.error('Error processing media pause:', error);
      this.showErrorMessage();
    } finally {
      this.hideLoadingIndicator();
    }
  }

  /**
   * Extract transcript from various possible DOM locations
   */
  extractTranscript(mediaElement) {
    console.log('Extracting transcript...');
    
    // Common transcript selectors for different platforms
    const transcriptSelectors = [
      // YouTube
      '.ytd-transcript-segment-renderer',
      '.ytd-transcript-body-renderer .segment-text',
      
      // Generic captions/subtitles
      '[class*="caption"]',
      '[class*="subtitle"]',
      '[class*="transcript"]',
      '.captions',
      '.subtitles',
      
      // HTML5 track elements
      'track[kind="captions"]',
      'track[kind="subtitles"]',
      
      // ARIA labels and descriptions
      '[aria-describedby]',
      '.sr-only',
      '.screen-reader-text'
    ];

    let transcript = '';

    // Try each selector
    for (const selector of transcriptSelectors) {
      const elements = document.querySelectorAll(selector);
      if (elements.length > 0) {
        console.log(`Found transcript elements with selector: ${selector}`);
        
        transcript = Array.from(elements)
          .map(el => el.textContent?.trim())
          .filter(text => text && text.length > 10) // Filter out very short text
          .join(' ');
          
        if (transcript.length > 50) { // Minimum viable transcript length
          break;
        }
      }
    }

    // Try to find transcript in nearby elements
    if (!transcript) {
      transcript = this.searchNearbyElements(mediaElement);
    }

    // Clean up transcript
    if (transcript) {
      transcript = transcript
        .replace(/\s+/g, ' ') // Normalize whitespace
        .replace(/\[\d+:\d+\]/g, '') // Remove timestamps like [1:23]
        .replace(/^\d+:\d+/gm, '') // Remove line-starting timestamps
        .trim();
    }

    console.log(`Extracted transcript (${transcript.length} chars):`, 
                transcript.substring(0, 200) + '...');
    
    return transcript.length > 50 ? transcript : null;
  }

  /**
   * Search for transcript in elements near the media element
   */
  searchNearbyElements(mediaElement) {
    const searchRadius = 3; // How many parent/sibling levels to search
    let currentElement = mediaElement;
    
    // Search parent elements
    for (let i = 0; i < searchRadius; i++) {
      if (!currentElement.parentElement) break;
      currentElement = currentElement.parentElement;
      
      const textContent = this.extractTextFromElement(currentElement);
      if (textContent && textContent.length > 100) {
        return textContent;
      }
    }
    
    return null;
  }

  /**
   * Extract clean text content from an element
   */
  extractTextFromElement(element) {
    // Clone element to avoid modifying original
    const clone = element.cloneNode(true);
    
    // Remove script and style elements
    clone.querySelectorAll('script, style, noscript').forEach(el => el.remove());
    
    return clone.textContent?.trim() || '';
  }

  /**
   * Generate cache key for transcript
   */
  generateCacheKey(transcript) {
    // Simple hash function for caching
    let hash = 0;
    for (let i = 0; i < transcript.length; i++) {
      const char = transcript.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
  }

  /**
   * Send transcript to AI service for summarization
   */
  async generateSummary(transcript) {
    console.log('Generating summary for transcript...');
    
    try {
      // Send to background script which will handle the API call
      const response = await chrome.runtime.sendMessage({
        action: 'generateSummary',
        transcript: transcript
      });
      
      return response.summary;
    } catch (error) {
      console.error('Error generating summary:', error);
      return null;
    }
  }

  /**
   * Display summary in an overlay
   */
  displaySummary(summary) {
    this.currentSummary = summary;
    
    // Remove existing overlay
    this.removeOverlay();
    
    // Create overlay container
    this.overlayContainer = document.createElement('div');
    this.overlayContainer.id = 'video-recap-overlay';
    this.overlayContainer.innerHTML = `
      <div class="recap-header">
        <h3>📝 Video Recap</h3>
        <div class="header-controls">
          <button class="speak-btn" title="Read summary aloud">🔊</button>
          <button class="close-btn" onclick="this.parentElement.parentElement.parentElement.remove()">×</button>
        </div>
      </div>
      <div class="recap-content">
        <p>${summary}</p>
      </div>
      <div class="recap-footer">
        <small>Generated by Video Recap Assistant</small>
      </div>
    `;
    
    // Apply styles
    this.applyOverlayStyles();
    
    // Add speech functionality
    this.setupSpeechControls();
    
    // Add to page
    document.body.appendChild(this.overlayContainer);
    
    // Auto-hide after 15 seconds
    setTimeout(() => {
      if (this.overlayContainer) {
        this.overlayContainer.style.opacity = '0.7';
      }
    }, 15000);
  }

  /**
   * Apply CSS styles to the overlay
   */
  applyOverlayStyles() {
    if (!this.overlayContainer) return;
    
    const styles = `
      position: fixed;
      top: 20px;
      right: 20px;
      width: 350px;
      max-width: calc(100vw - 40px);
      background: #ffffff;
      border: 1px solid #e0e0e0;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      transition: opacity 0.3s ease;
      backdrop-filter: blur(10px);
    `;
    
    this.overlayContainer.style.cssText = styles;
    
    // Style header
    const header = this.overlayContainer.querySelector('.recap-header');
    if (header) {
      header.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 16px 20px 12px;
        border-bottom: 1px solid #f0f0f0;
        margin: 0;
      `;
      
      const h3 = header.querySelector('h3');
      if (h3) {
        h3.style.cssText = `
          margin: 0;
          font-size: 16px;
          font-weight: 600;
          color: #333;
          flex-grow: 1;
        `;
      }
      
      const headerControls = header.querySelector('.header-controls');
      if (headerControls) {
        headerControls.style.cssText = `
          display: flex;
          gap: 8px;
          align-items: center;
        `;
      }
      
      const speakBtn = header.querySelector('.speak-btn');
      if (speakBtn) {
        speakBtn.style.cssText = `
          background: none;
          border: none;
          font-size: 16px;
          cursor: pointer;
          color: #666;
          padding: 4px;
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
          transition: all 0.2s ease;
        `;
        
        speakBtn.addEventListener('mouseenter', () => {
          speakBtn.style.backgroundColor = '#f5f5f5';
          speakBtn.style.transform = 'scale(1.05)';
        });
        
        speakBtn.addEventListener('mouseleave', () => {
          speakBtn.style.backgroundColor = 'transparent';
          speakBtn.style.transform = 'scale(1)';
        });
      }
      
      const closeBtn = header.querySelector('.close-btn');
      if (closeBtn) {
        closeBtn.style.cssText = `
          background: none;
          border: none;
          font-size: 20px;
          cursor: pointer;
          color: #666;
          padding: 0;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
        `;
        
        closeBtn.addEventListener('mouseenter', () => {
          closeBtn.style.backgroundColor = '#f5f5f5';
        });
        
        closeBtn.addEventListener('mouseleave', () => {
          closeBtn.style.backgroundColor = 'transparent';
        });
      }
    }
    
    // Style content
    const content = this.overlayContainer.querySelector('.recap-content');
    if (content) {
      content.style.cssText = `
        padding: 16px 20px;
        color: #444;
        max-height: 300px;
        overflow-y: auto;
      `;
      
      const p = content.querySelector('p');
      if (p) {
        p.style.cssText = `
          margin: 0;
          line-height: 1.6;
        `;
      }
    }
    
    // Style footer
    const footer = this.overlayContainer.querySelector('.recap-footer');
    if (footer) {
      footer.style.cssText = `
        padding: 8px 20px 16px;
        text-align: center;
        border-top: 1px solid #f0f0f0;
      `;
      
      const small = footer.querySelector('small');
      if (small) {
        small.style.cssText = `
          color: #888;
          font-size: 12px;
        `;
      }
    }
  }

  /**
   * Show loading indicator
   */
  showLoadingIndicator() {
    this.removeOverlay();
    
    this.overlayContainer = document.createElement('div');
    this.overlayContainer.id = 'video-recap-overlay';
    this.overlayContainer.innerHTML = `
      <div class="recap-header">
        <h3>🤔 Analyzing content...</h3>
      </div>
      <div class="recap-content">
        <div class="loading-spinner"></div>
        <p>Generating your recap...</p>
      </div>
    `;
    
    this.applyOverlayStyles();
    
    // Add spinner styles
    const spinner = this.overlayContainer.querySelector('.loading-spinner');
    if (spinner) {
      spinner.style.cssText = `
        width: 24px;
        height: 24px;
        border: 3px solid #f3f3f3;
        border-top: 3px solid #007bff;
        border-radius: 50%;
        animation: spin 1s linear infinite;
        margin: 0 auto 12px;
      `;
      
      // Add keyframe animation
      if (!document.querySelector('#recap-spinner-styles')) {
        const style = document.createElement('style');
        style.id = 'recap-spinner-styles';
        style.textContent = `
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `;
        document.head.appendChild(style);
      }
    }
    
    document.body.appendChild(this.overlayContainer);
  }

  /**
   * Hide loading indicator
   */
  hideLoadingIndicator() {
    // Loading indicator will be replaced by summary or error message
  }

  /**
   * Show fallback message when no transcript is found
   */
  showFallbackMessage() {
    this.displayMessage(
      '🔍 No Transcript Found',
      'We couldn\'t find any transcript or captions for this content. The recap feature works best with videos that have available transcripts or captions.',
      'info'
    );
  }

  /**
   * Show error message
   */
  showErrorMessage() {
    this.displayMessage(
      '❌ Error',
      'Sorry, we couldn\'t generate a recap at this time. Please try again later.',
      'error'
    );
  }

  /**
   * Display a generic message in the overlay
   */
  displayMessage(title, message, type = 'info') {
    this.removeOverlay();
    
    this.overlayContainer = document.createElement('div');
    this.overlayContainer.id = 'video-recap-overlay';
    this.overlayContainer.innerHTML = `
      <div class="recap-header">
        <h3>${title}</h3>
        <button class="close-btn" onclick="this.parentElement.parentElement.remove()">×</button>
      </div>
      <div class="recap-content">
        <p>${message}</p>
      </div>
    `;
    
    this.applyOverlayStyles();
    
    // Apply type-specific styling
    if (type === 'error') {
      this.overlayContainer.style.borderColor = '#ff6b6b';
    } else if (type === 'info') {
      this.overlayContainer.style.borderColor = '#4dabf7';
    }
    
    document.body.appendChild(this.overlayContainer);
    
    // Auto-hide after 8 seconds
    setTimeout(() => {
      if (this.overlayContainer) {
        this.overlayContainer.remove();
      }
    }, 8000);
  }

  /**
   * Set up speech controls for the overlay
   */
  setupSpeechControls() {
    const speakBtn = this.overlayContainer?.querySelector('.speak-btn');
    if (!speakBtn) return;

    let isCurrentlySpeaking = false;

    speakBtn.addEventListener('click', async () => {
      if (isCurrentlySpeaking) {
        // Stop current speech
        this.stopSpeech();
        this.updateSpeakButton(speakBtn, false);
        isCurrentlySpeaking = false;
      } else {
        // Start speech
        try {
          this.updateSpeakButton(speakBtn, true);
          isCurrentlySpeaking = true;
          
          await this.speakSummary(this.currentSummary, () => {
            // Speech ended callback
            this.updateSpeakButton(speakBtn, false);
            isCurrentlySpeaking = false;
          });
        } catch (error) {
          console.error('Error with text-to-speech:', error);
          this.updateSpeakButton(speakBtn, false);
          isCurrentlySpeaking = false;
          this.showSpeechError();
        }
      }
    });
  }

  /**
   * Update speak button appearance
   */
  updateSpeakButton(button, isSpeaking) {
    if (!button) return;
    
    if (isSpeaking) {
      button.textContent = '⏸️';
      button.title = 'Stop reading';
      button.style.color = '#007bff';
    } else {
      button.textContent = '🔊';
      button.title = 'Read summary aloud';
      button.style.color = '#666';
    }
  }

  /**
   * Speak the summary using Chrome's TTS API
   */
  async speakSummary(text, onEndCallback) {
    if (!text) return;

    try {
      // Get user's speech preferences
      const settings = await chrome.storage.local.get(['speechSettings']);
      const speechSettings = settings.speechSettings || {
        rate: 1.0,
        pitch: 1.0,
        volume: 0.8,
        voiceName: null // Will use default voice
      };

      // Send message to background script to handle TTS
      const response = await chrome.runtime.sendMessage({
        action: 'speakText',
        text: text,
        settings: speechSettings
      });

      if (response.success) {
        // Set up listener for when speech ends
        const handleSpeechEnd = (message) => {
          if (message.action === 'speechEnded') {
            chrome.runtime.onMessage.removeListener(handleSpeechEnd);
            if (onEndCallback) onEndCallback();
          }
        };
        
        chrome.runtime.onMessage.addListener(handleSpeechEnd);
      } else {
        throw new Error(response.error || 'TTS failed');
      }
    } catch (error) {
      console.error('Speech error:', error);
      if (onEndCallback) onEndCallback();
      throw error;
    }
  }

  /**
   * Stop current speech
   */
  stopSpeech() {
    chrome.runtime.sendMessage({
      action: 'stopSpeech'
    }).catch(error => {
      console.error('Error stopping speech:', error);
    });
  }

  /**
   * Show speech error message
   */
  showSpeechError() {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
      position: fixed;
      top: 80px;
      right: 20px;
      background: #fee2e2;
      color: #dc2626;
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid #fecaca;
      font-size: 14px;
      z-index: 2147483648;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    `;
    errorDiv.textContent = 'Speech unavailable. Please check your system settings.';
    
    document.body.appendChild(errorDiv);
    
    setTimeout(() => {
      if (errorDiv.parentNode) {
        errorDiv.parentNode.removeChild(errorDiv);
      }
    }, 3000);
  }
  removeOverlay() {
    const existing = document.getElementById('video-recap-overlay');
    if (existing) {
      existing.remove();
    }
    this.overlayContainer = null;
  }

  /**
   * Store summary for popup access
   */
  async storeSummary(summary, transcript) {
    try {
      await chrome.storage.local.set({
        lastSummary: summary,
        lastTranscript: transcript.substring(0, 500), // Store first 500 chars
        timestamp: Date.now()
      });
    } catch (error) {
      console.error('Error storing summary:', error);
    }
  }

  /**
   * Handle messages from popup or background script
   */
  handleMessage(message, sender, sendResponse) {
    switch (message.action) {
      case 'getCurrentSummary':
        sendResponse({
          summary: this.currentSummary,
          hasOverlay: !!this.overlayContainer
        });
        break;
        
      case 'toggleOverlay':
        if (this.overlayContainer) {
          this.removeOverlay();
        } else if (this.currentSummary) {
          this.displaySummary(this.currentSummary);
        }
        sendResponse({ success: true });
        break;
        
      default:
        sendResponse({ error: 'Unknown action' });
    }
  }
}

// Initialize the monitor when the page loads
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new VideoRecapMonitor();
  });
} else {
  new VideoRecapMonitor();
}
