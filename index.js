/**
 * Beholder - SillyTavern Extension
 * An AI assistant that observes and comments on your roleplay
 */

const MODULE_NAME = 'beholder';
const MODULE_NAME_FANCY = 'Beholder';

// Default system prompt
const DEFAULT_SYSTEM_PROMPT = `You are an assistant character who observes and comments on a roleplay happening in a "main chat" between a User and another AI character. You are NOT part of that roleplay - you are a separate entity having your own conversation with the User in this "assistant chat".

You can see excerpts from the main roleplay chat. You should comment on it, react to what's happening, give feedback, or just chat with the User about it. You cannot directly influence or change the main roleplay.

The User may ask you questions about the roleplay, request advice, or just want to chat. Respond in character according to your Character Prompt.

Format of context you'll receive:
- <main_chat> contains recent messages from the main roleplay
- <assistant_chat> contains our previous conversation (if any)
- The User's new message follows

Remember: You are an onlooker/beholder of the main chat, not a participant.`;

// Default character prompt
const DEFAULT_CHARACTER_PROMPT = `You are a witty, slightly sarcastic companion who enjoys watching and commenting on roleplays. You have your own personality and opinions. Feel free to:
- Make observations about plot developments
- Comment on character decisions (good or questionable)
- Offer encouragement or gentle teasing
- Share your reactions to dramatic or romantic moments
- Give advice if asked

Keep responses conversational and relatively brief (1-3 paragraphs typically). Match the tone of the roleplay when appropriate - be more serious for dramatic scenes, more playful for lighthearted ones.`;

// Default settings
const DEFAULT_SETTINGS = {
    enabled: true,
    assistant_name: 'Beholder',
    endpoint_url: '',
    endpoint_api_key: '',
    system_prompt: DEFAULT_SYSTEM_PROMPT,
    character_prompt: DEFAULT_CHARACTER_PROMPT,
    main_chat_depth: 5,
    assistant_chat_depth: 10,
    min_wait: 30,
    max_wait: 120
};

// State variables
let settings = {};
let assistantMessages = [];
let autoGenTimer = null;
let abortController = null;
let isGenerating = false;
let eventsRegistered = false;

// Panel state
let POPOUT_VISIBLE = false;
let POPOUT_LOCKED = false;
let $POPOUT = null;
let $DRAWER_CONTENT = null;

// ==================== SETTINGS FUNCTIONS ====================

function get_settings(key) {
    if (settings.hasOwnProperty(key)) {
        return settings[key];
    }
    return DEFAULT_SETTINGS[key];
}

function set_settings(key, value) {
    settings[key] = value;
    save_settings();
}

function load_settings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = {};
    }
    settings = Object.assign({}, DEFAULT_SETTINGS, context.extensionSettings[MODULE_NAME].settings || {});
}

function save_settings() {
    const context = SillyTavern.getContext();
    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = {};
    }
    context.extensionSettings[MODULE_NAME].settings = settings;
    context.saveSettingsDebounced();
}

// ==================== MESSAGE PERSISTENCE ====================

function get_chat_id() {
    const context = SillyTavern.getContext();
    return context.chatId || 'default';
}

function save_messages() {
    const context = SillyTavern.getContext();
    const chatId = get_chat_id();

    if (!context.extensionSettings[MODULE_NAME]) {
        context.extensionSettings[MODULE_NAME] = {};
    }
    if (!context.extensionSettings[MODULE_NAME].chatMessages) {
        context.extensionSettings[MODULE_NAME].chatMessages = {};
    }

    context.extensionSettings[MODULE_NAME].chatMessages[chatId] = {
        messages: assistantMessages,
        timestamp: Date.now()
    };

    context.saveSettingsDebounced();
}

function load_messages() {
    const context = SillyTavern.getContext();
    const chatId = get_chat_id();

    const stored = context.extensionSettings[MODULE_NAME]?.chatMessages?.[chatId];

    if (stored && stored.messages) {
        assistantMessages = stored.messages;
    } else {
        assistantMessages = [];
    }
}

// ==================== TAB NAVIGATION ====================

function initialize_tab_navigation() {
    const $tabs = $('.bh_tab');
    const $panels = $('.bh_tab_content');

    $tabs.on('click', function() {
        const targetTab = $(this).data('tab');

        $tabs.removeClass('bh_tab_active');
        $(this).addClass('bh_tab_active');

        $panels.removeClass('bh_tab_content_active').hide();
        $(`.bh_tab_content[data-tab="${targetTab}"]`)
            .addClass('bh_tab_content_active')
            .show();
    });

    // Initialize first tab
    $tabs.first().addClass('bh_tab_active');
    $panels.not(':first').hide();
}

// ==================== POPOUT SYSTEM ====================

function add_popout_button() {
    const $header = $('#beholder_settings .inline-drawer-header');

    const $button = $(`
        <i id="bh_popout_button"
           class="fa-solid fa-window-restore menu_button margin0 interactable"
           tabindex="0"
           title="Pop out to floating window">
        </i>
    `);

    $button.css({
        'margin-left': 'auto',
        'margin-right': '10px',
        'display': 'inline-flex',
        'vertical-align': 'middle',
        'cursor': 'pointer'
    });

    $button.on('click', (event) => {
        event.stopPropagation();
        event.preventDefault();
        togglePopout();
    });

    const $chevron = $header.find('.inline-drawer-icon');
    if ($chevron.length > 0) {
        $button.insertBefore($chevron);
    } else {
        $header.append($button);
    }
}

function togglePopout() {
    if (POPOUT_VISIBLE) {
        closePopout();
    } else {
        openPopout();
    }
}

function openPopout() {
    const $inlineDrawer = $('#beholder_settings .inline-drawer-content');
    const $drawerContentElement = $inlineDrawer.children().first();

    $POPOUT = $(`
        <div id="bh_popout" class="draggable" style="display: none;">
            <div class="panelControlBar flex-container" id="bhPopoutHeader">
                <div class="title"><i class="fa-solid fa-eye"></i> ${MODULE_NAME_FANCY}</div>
                <div class="flex1"></div>
                <div class="fa-solid fa-arrows-left-right hoverglow dragReset" title="Reset to default size"></div>
                <div class="fa-solid fa-grip drag-grabber hoverglow" title="Drag to move"></div>
                <div class="fa-solid fa-lock-open hoverglow dragLock" title="Lock position"></div>
                <div class="fa-solid fa-circle-xmark hoverglow dragClose" title="Close"></div>
            </div>
            <div id="bh_popout_content_container"></div>
        </div>
    `);

    $('body').append($POPOUT);

    $drawerContentElement.detach().appendTo($POPOUT.find('#bh_popout_content_container'));
    $DRAWER_CONTENT = $drawerContentElement;

    // Set up dragging
    try {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.dragElement === 'function') {
            ctx.dragElement($POPOUT);
        } else if (typeof window.dragElement === 'function') {
            window.dragElement($POPOUT);
        } else {
            make_popout_draggable($POPOUT);
        }
    } catch (e) {
        make_popout_draggable($POPOUT);
    }

    load_popout_position();

    // Set up handlers
    $POPOUT.find('.dragClose').on('click', () => closePopout());
    $POPOUT.find('.dragLock').on('click', () => togglePopoutLock());
    $POPOUT.find('.dragReset').on('click', () => resetPopoutSize());

    // Track manual resizes
    const resizeObserver = new ResizeObserver(debounce(() => {
        $POPOUT.data('user-resized', true);
        save_popout_position();
    }, 250));
    resizeObserver.observe($POPOUT[0]);
    $POPOUT.data('resize-observer', resizeObserver);

    $POPOUT.fadeIn(250);
    POPOUT_VISIBLE = true;
    update_popout_button_state();
}

function closePopout() {
    if (!POPOUT_VISIBLE || !$POPOUT) return;

    save_popout_position();

    const $currentPopout = $POPOUT;
    const $currentDrawerContent = $DRAWER_CONTENT;
    const $inlineDrawer = $('#beholder_settings .inline-drawer-content');

    const resizeObserver = $currentPopout.data('resize-observer');
    if (resizeObserver) {
        resizeObserver.disconnect();
    }

    $currentPopout.fadeOut(250, () => {
        $currentDrawerContent.detach().appendTo($inlineDrawer);
        $currentPopout.remove();

        POPOUT_VISIBLE = false;
        $POPOUT = null;
        $DRAWER_CONTENT = null;
        update_popout_button_state();
    });
}

function make_popout_draggable($element) {
    const $header = $element.find('#bhPopoutHeader');
    let isDragging = false;
    let startX, startY, initialX, initialY;

    $header.on('mousedown', (e) => {
        if (POPOUT_LOCKED) return;
        if ($(e.target).hasClass('dragClose') ||
            $(e.target).hasClass('dragLock') ||
            $(e.target).hasClass('dragReset')) return;

        isDragging = true;
        const rect = $element[0].getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        initialX = rect.left;
        initialY = rect.top;
        $header.css('cursor', 'grabbing');
    });

    $(document).on('mousemove.bhPopout', (e) => {
        if (!isDragging) return;

        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;
        let newX = initialX + deltaX;
        let newY = initialY + deltaY;

        newX = Math.max(0, Math.min(newX, window.innerWidth - $element.outerWidth()));
        newY = Math.max(0, Math.min(newY, window.innerHeight - $element.outerHeight()));

        $element.css({
            left: newX + 'px',
            top: newY + 'px',
            right: 'auto',
            bottom: 'auto'
        });
    });

    $(document).on('mouseup.bhPopout', () => {
        if (isDragging) {
            isDragging = false;
            $header.css('cursor', 'grab');
            save_popout_position();
        }
    });
}

function save_popout_position() {
    if (!$POPOUT) return;
    const position = {
        left: $POPOUT.css('left'),
        top: $POPOUT.css('top'),
        right: $POPOUT.css('right'),
        width: $POPOUT.data('user-resized') ? $POPOUT.css('width') : null,
        locked: POPOUT_LOCKED
    };
    localStorage.setItem('bh_popout_position', JSON.stringify(position));
}

function load_popout_position() {
    if (!$POPOUT) return;
    try {
        const stored = localStorage.getItem('bh_popout_position');
        if (stored) {
            const position = JSON.parse(stored);
            if (position.left) $POPOUT.css('left', position.left);
            if (position.top) $POPOUT.css('top', position.top);
            if (position.width) {
                $POPOUT.css('width', position.width);
                $POPOUT.data('user-resized', true);
            }
            if (position.locked) {
                POPOUT_LOCKED = true;
                update_lock_button_ui();
            }
        }
    } catch (e) {
        // Ignore errors
    }
}

function togglePopoutLock() {
    POPOUT_LOCKED = !POPOUT_LOCKED;
    update_lock_button_ui();
    save_popout_position();
}

function update_lock_button_ui() {
    if (!$POPOUT) return;
    const $button = $POPOUT.find('.dragLock');

    if (POPOUT_LOCKED) {
        $button.removeClass('fa-lock-open').addClass('fa-lock locked');
        $button.attr('title', 'Unlock position');
        $POPOUT.addClass('position-locked');
    } else {
        $button.removeClass('fa-lock locked').addClass('fa-lock-open');
        $button.attr('title', 'Lock position');
        $POPOUT.removeClass('position-locked');
    }
}

function resetPopoutSize() {
    if (!$POPOUT) return;
    $POPOUT.css('width', '450px');
    $POPOUT.data('user-resized', false);
    save_popout_position();
}

function update_popout_button_state() {
    const $button = $('#bh_popout_button');
    if (POPOUT_VISIBLE) {
        $button.addClass('active');
    } else {
        $button.removeClass('active');
    }
}

// ==================== ENDPOINT TEST ====================

async function test_endpoint() {
    const $status = $('#bh_endpoint_status');
    const $button = $('#bh_endpoint_test');
    const urlInput = $('#bh_endpoint_url').val().trim();
    const apiKeyInput = $('#bh_endpoint_api_key').val().trim();

    if (!urlInput) {
        $status.removeClass().addClass('bh_status_message bh_status_error')
            .text('Please enter an endpoint URL');
        return;
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(urlInput);
    } catch {
        $status.removeClass().addClass('bh_status_message bh_status_error')
            .text('Invalid URL format');
        return;
    }

    $status.removeClass().addClass('bh_status_message bh_status_info')
        .text('Testing connection...');
    $button.prop('disabled', true);

    const headers = { 'Content-Type': 'application/json' };
    if (apiKeyInput) headers['Authorization'] = `Bearer ${apiKeyInput}`;

    const body = JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: "Say 'Connection successful!' in a brief, friendly way." }
        ],
        max_tokens: 50,
        temperature: 0.7,
        stream: false
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const resp = await fetch(parsedUrl.toString(), {
            method: 'POST',
            headers,
            body,
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (resp.ok) {
            const data = await resp.json();
            const content = data?.choices?.[0]?.message?.content || '';
            if (content) {
                $status.removeClass().addClass('bh_status_message bh_status_success')
                    .text(`Connected! Response: "${content.substring(0, 80)}${content.length > 80 ? '...' : ''}"`);
            } else {
                $status.removeClass().addClass('bh_status_message bh_status_error')
                    .text('Unexpected response format');
            }
        } else if (resp.status === 401 || resp.status === 403) {
            $status.removeClass().addClass('bh_status_message bh_status_error')
                .text(`Authentication failed (HTTP ${resp.status})`);
        } else {
            $status.removeClass().addClass('bh_status_message bh_status_error')
                .text(`HTTP ${resp.status}: ${resp.statusText}`);
        }
    } catch (e) {
        clearTimeout(timeout);
        if (e.name === 'AbortError') {
            $status.removeClass().addClass('bh_status_message bh_status_error')
                .text('Connection timed out (10s)');
        } else {
            $status.removeClass().addClass('bh_status_message bh_status_error')
                .text(`Network error: ${e.message}`);
        }
    } finally {
        $button.prop('disabled', false);
    }
}

// ==================== CONTEXT BUILDER ====================

function build_context(userMessage = null) {
    const context = SillyTavern.getContext();
    const mainChat = context.chat || [];

    // Get main chat history (excluding system messages)
    const mainDepth = get_settings('main_chat_depth');
    const visibleMainChat = mainChat.filter(m => !m.is_system);
    const mainHistory = visibleMainChat.slice(-mainDepth);

    // Format main chat
    let mainChatText = '';
    if (mainHistory.length > 0) {
        mainChatText = mainHistory.map(m => `${m.name}: ${m.mes}`).join('\n');
    } else {
        mainChatText = '(No main chat activity yet)';
    }

    // Get assistant chat history
    const assistantDepth = get_settings('assistant_chat_depth');
    const recentAssistant = assistantMessages.slice(-assistantDepth);

    // Format assistant chat
    let assistantChatText = '';
    if (recentAssistant.length > 0) {
        const assistantName = get_settings('assistant_name') || 'Beholder';
        assistantChatText = recentAssistant.map(m =>
            `${m.role === 'user' ? 'User' : assistantName}: ${m.content}`
        ).join('\n');
    }

    // Build full context
    let fullContext = `<main_chat>\n${mainChatText}\n</main_chat>`;

    if (assistantChatText) {
        fullContext += `\n\n<assistant_chat>\n${assistantChatText}\n</assistant_chat>`;
    }

    if (userMessage) {
        fullContext += `\n\nUser's new message: ${userMessage}`;
    } else {
        fullContext += '\n\n(Auto-generated commentary request - comment on the main chat above)';
    }

    return fullContext;
}

// ==================== GENERATION FUNCTION ====================

async function generate_response(userMessage = null) {
    const url = get_settings('endpoint_url');
    const apiKey = get_settings('endpoint_api_key');

    if (!url) {
        show_status('No endpoint configured', 'error');
        return null;
    }

    if (isGenerating) {
        return null;
    }

    isGenerating = true;
    set_input_state(false);
    show_status('Generating response...', 'info');

    const systemPrompt = get_settings('system_prompt');
    const characterPrompt = get_settings('character_prompt');
    const contextText = build_context(userMessage);

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const body = JSON.stringify({
        model: 'gpt-3.5-turbo',
        messages: [
            { role: 'system', content: `${systemPrompt}\n\n${characterPrompt}` },
            { role: 'user', content: contextText }
        ],
        max_tokens: 1024,
        temperature: 0.8,
        stream: false
    });

    abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 60000);

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers,
            body,
            signal: abortController.signal
        });
        clearTimeout(timeout);

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        }

        const data = await resp.json();
        const content = data?.choices?.[0]?.message?.content;

        if (!content) {
            throw new Error('Empty response from endpoint');
        }

        show_status('', 'clear');
        return content.trim();

    } catch (e) {
        clearTimeout(timeout);
        if (e.name === 'AbortError') {
            show_status('Generation cancelled', 'info');
        } else {
            show_status(`Error: ${e.message}`, 'error');
        }
        return null;
    } finally {
        isGenerating = false;
        abortController = null;
        set_input_state(true);
    }
}

// ==================== CHAT UI FUNCTIONS ====================

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function render_messages() {
    const $container = $('#bh_chat_messages');
    $container.empty();

    const assistantName = get_settings('assistant_name') || 'Beholder';

    if (assistantMessages.length === 0) {
        $container.html(`
            <div class="bh_empty_state">
                <i class="fa-solid fa-comments"></i>
                <span>No messages yet. Say something or wait for auto-commentary after main chat activity.</span>
            </div>
        `);
        return;
    }

    for (const msg of assistantMessages) {
        const timeStr = new Date(msg.timestamp).toLocaleTimeString([],
            { hour: '2-digit', minute: '2-digit' });
        const roleClass = msg.role === 'user' ? 'bh_message_user' : 'bh_message_assistant';
        const roleName = msg.role === 'user' ? 'You' : escapeHtml(assistantName);

        const $msg = $(`
            <div class="bh_message ${roleClass}">
                <div class="bh_message_header">
                    <span class="bh_message_name">${roleName}</span>
                    <span class="bh_message_time">${timeStr}</span>
                </div>
                <div class="bh_message_content">${escapeHtml(msg.content)}</div>
            </div>
        `);

        $container.append($msg);
    }

    scroll_to_bottom();
}

function add_message(role, content) {
    assistantMessages.push({
        role,
        content,
        timestamp: Date.now()
    });
    save_messages();
    render_messages();
}

function scroll_to_bottom() {
    const $container = $('#bh_chat_messages');
    if ($container[0]) {
        $container[0].scrollTop = $container[0].scrollHeight;
    }
}

function show_status(message, type) {
    const $status = $('#bh_generation_status');
    if (type === 'clear' || !message) {
        $status.removeClass().addClass('bh_status_message').text('');
    } else {
        $status.removeClass().addClass(`bh_status_message bh_status_${type}`).text(message);
    }
}

function set_input_state(enabled) {
    $('#bh_chat_input').prop('disabled', !enabled);
    $('#bh_chat_send').prop('disabled', !enabled);
    $('#bh_chat_regenerate').prop('disabled', !enabled);
}

// ==================== USER SEND HANDLER ====================

async function handle_user_send() {
    const $input = $('#bh_chat_input');
    const message = $input.val().trim();

    if (!message) return;
    if (isGenerating) return;

    add_message('user', message);
    $input.val('');

    const response = await generate_response(message);

    if (response) {
        add_message('assistant', response);
    }

    // Stop any pending auto-gen since we just interacted
    stop_auto_gen_timer();
}

function initialize_chat_handlers() {
    $('#bh_chat_send').on('click', handle_user_send);

    $('#bh_chat_input').on('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handle_user_send();
        }
    });

    $('#bh_chat_clear').on('click', function() {
        if (confirm('Clear all messages in this conversation?')) {
            assistantMessages = [];
            save_messages();
            render_messages();
        }
    });

    $('#bh_chat_regenerate').on('click', async function() {
        if (isGenerating) return;
        const response = await generate_response(null);
        if (response) {
            add_message('assistant', response);
        }
    });
}

// ==================== AUTO GENERATION TIMER ====================

function start_auto_gen_timer() {
    if (!get_settings('enabled')) return;
    if (!get_settings('endpoint_url')) return;

    stop_auto_gen_timer();

    const minWait = get_settings('min_wait') * 1000;
    const maxWait = get_settings('max_wait') * 1000;
    const actualMax = Math.max(maxWait, minWait + 10000);

    const delay = minWait + Math.random() * (actualMax - minWait);

    autoGenTimer = setTimeout(async () => {
        if (!get_settings('enabled')) return;
        if (isGenerating) {
            autoGenTimer = setTimeout(() => start_auto_gen_timer(), 5000);
            return;
        }

        const response = await generate_response(null);
        if (response) {
            add_message('assistant', response);
        }

        autoGenTimer = null;
    }, delay);
}

function stop_auto_gen_timer() {
    if (autoGenTimer) {
        clearTimeout(autoGenTimer);
        autoGenTimer = null;
    }
}

function on_main_chat_message() {
    if (!get_settings('enabled')) return;
    stop_auto_gen_timer();
    start_auto_gen_timer();
}

// ==================== EVENT HANDLERS ====================

function register_events() {
    if (eventsRegistered) return;

    const context = SillyTavern.getContext();

    context.eventSource.on(context.eventTypes.MESSAGE_RECEIVED, () => {
        on_main_chat_message();
    });

    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        stop_auto_gen_timer();
        load_messages();
        render_messages();
    });

    eventsRegistered = true;
}

// ==================== SETTINGS BINDING ====================

function bind_settings() {
    // Enable toggle
    $('#bh_enabled').on('change', function() {
        set_settings('enabled', $(this).prop('checked'));
        if (!$(this).prop('checked')) {
            stop_auto_gen_timer();
        }
    }).prop('checked', get_settings('enabled'));

    // Assistant name
    $('#bh_assistant_name').on('change', function() {
        set_settings('assistant_name', $(this).val().trim() || 'Beholder');
        render_messages();
    }).val(get_settings('assistant_name'));

    // Endpoint
    $('#bh_endpoint_url').on('change', function() {
        set_settings('endpoint_url', $(this).val().trim());
    }).val(get_settings('endpoint_url'));

    $('#bh_endpoint_api_key').on('change', function() {
        set_settings('endpoint_api_key', $(this).val());
    }).val(get_settings('endpoint_api_key'));

    $('#bh_endpoint_test').on('click', test_endpoint);

    // Prompts
    $('#bh_system_prompt').on('change', function() {
        set_settings('system_prompt', $(this).val());
    }).val(get_settings('system_prompt'));

    $('#bh_character_prompt').on('change', function() {
        set_settings('character_prompt', $(this).val());
    }).val(get_settings('character_prompt'));

    // History depths
    $('#bh_main_chat_depth').on('change', function() {
        let val = parseInt($(this).val()) || 5;
        val = Math.max(1, Math.min(20, val));
        set_settings('main_chat_depth', val);
        $(this).val(val);
    }).val(get_settings('main_chat_depth'));

    $('#bh_assistant_chat_depth').on('change', function() {
        let val = parseInt($(this).val()) || 10;
        val = Math.max(1, Math.min(20, val));
        set_settings('assistant_chat_depth', val);
        $(this).val(val);
    }).val(get_settings('assistant_chat_depth'));

    // Timing
    $('#bh_min_wait').on('change', function() {
        let val = parseInt($(this).val()) || 30;
        val = Math.max(5, Math.min(300, val));
        set_settings('min_wait', val);
        $(this).val(val);
    }).val(get_settings('min_wait'));

    $('#bh_max_wait').on('change', function() {
        let val = parseInt($(this).val()) || 120;
        val = Math.max(10, Math.min(600, val));
        const minVal = get_settings('min_wait');
        if (val < minVal + 10) val = minVal + 10;
        set_settings('max_wait', val);
        $(this).val(val);
    }).val(get_settings('max_wait'));
}

// ==================== UTILITY FUNCTIONS ====================

function debounce(func, wait) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// ==================== INITIALIZATION ====================

async function init() {
    // Load settings
    load_settings();

    // Load HTML template
    const context = SillyTavern.getContext();
    const settingsHtml = await $.get(`${context.extensionFolderPath}/third-party/Beholder/settings.html`);
    $('#extensions_settings2').append(settingsHtml);

    // Initialize UI
    initialize_tab_navigation();
    add_popout_button();
    bind_settings();
    initialize_chat_handlers();

    // Load messages for current chat
    load_messages();
    render_messages();

    // Register events
    register_events();

    console.log('[Beholder] Extension loaded');
}

// jQuery ready
jQuery(async () => {
    await init();
});
