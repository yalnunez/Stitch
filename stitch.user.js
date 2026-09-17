// ==UserScript==
// @name         Stitch Time Off Bot
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  UI Panel to automate Create Time Off in Amazon Vibe
// @author       Yalnunez
// @match        https://vibe.a2z.com/*
// @updateURL    https://raw.githubusercontent.com/yalnunez/Stitch/main/stitch.user.js
// @downloadURL  https://raw.githubusercontent.com/yalnunez/Stitch/main/stitch.user.js
// @grant        GM_addStyle
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // ⚙️ CONFIG
    // ============================================================
    var DELAY_BETWEEN_STEPS = 1000;
    var DELAY_AFTER_SCHEDULE = 2000;
    var DELAY_AFTER_SUBMIT = 3000;
    var DELAY_AFTER_EDIT = 2000;
    var DELAY_DROPDOWN_OPEN = 2000;
    var DELAY_DROPDOWN_FILTER = 2000;
    var MAX_CUSTOM_DURATION_RETRIES = 2;
    var isProcessing = false;
    var shouldStop = false;
    var failedRecords = []; // Track failed records for final report

    // ============================================================
    // 🛡️ ANTI-THROTTLE: Keep timers alive in background tabs
    // ============================================================
    // Browsers throttle setTimeout/setInterval in background tabs.
    // Strategy: try Web Worker first; if CSP blocks it, fall back
    // to MessageChannel (not throttled). Only patch setTimeout
    // AFTER confirming the alternative timer actually works.

    (function installAntiThrottle() {
        var _nativeSetTimeout = window.setTimeout.bind(window);
        var _nativeClearTimeout = window.clearTimeout.bind(window);
        var _nativeSetInterval = window.setInterval.bind(window);
        var _nativeClearInterval = window.clearInterval.bind(window);

        // --- MessageChannel-based anti-throttle ---
        // MessageChannel.port.postMessage is NOT throttled in background
        // tabs, unlike setTimeout. We use it to create a fast timer.
        var pendingCallbacks = {};
        var nextTimerId = 1;
        var channel = new MessageChannel();

        channel.port1.onmessage = function (evt) {
            var id = evt.data.id;
            if (pendingCallbacks[id]) {
                var cb = pendingCallbacks[id];
                delete pendingCallbacks[id];
                cb();
            }
        };
        channel.port1.start();
        channel.port2.start();

        // Patched setTimeout: uses native setTimeout for the delay,
        // but fires the callback via MessageChannel so it isn't
        // delayed further by background-tab throttling.
        window.setTimeout = function stitchSetTimeout(fn, delayMs) {
            if (typeof fn !== 'function') {
                return _nativeSetTimeout(fn, delayMs);
            }
            delayMs = delayMs || 0;
            var id = nextTimerId++;

            pendingCallbacks[id] = fn;
            // Use native setTimeout for the delay portion, then
            // hand off to MessageChannel for the actual callback
            _nativeSetTimeout(function () {
                if (pendingCallbacks[id]) {
                    channel.port2.postMessage({ id: id });
                }
            }, delayMs);
            return id;
        };

        window.clearTimeout = function stitchClearTimeout(id) {
            if (pendingCallbacks[id]) delete pendingCallbacks[id];
            _nativeClearTimeout(id);
        };

        console.log('[Stitch] 🛡️ Anti-throttle installed (MessageChannel) — background tabs supported');
    })();

    // ============================================================
    // 🛠️ UTILITIES
    // ============================================================

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    function waitForElement(selectorFn, description, timeout) {
        timeout = timeout || 15000;
        return new Promise(function (resolve, reject) {
            var el = selectorFn();
            if (el) return resolve(el);
            var interval = setInterval(function () {
                var el = selectorFn();
                if (el) { clearInterval(interval); resolve(el); }
            }, 300);
            setTimeout(function () {
                clearInterval(interval);
                reject(new Error('Timeout: ' + description));
            }, timeout);
        });
    }

    function setNativeValue(element, value) {
        var setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        ).set;
        setter.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        element.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    // ============================================================
    // 🔍 FIND ELEMENTS
    // ============================================================

    function findInputByLabel(labelText) {
        var labels = document.querySelectorAll('label, span[class*="label"]');
        for (var i = 0; i < labels.length; i++) {
            var label = labels[i];
            var input;
            if (label.textContent.trim().toLowerCase().includes(labelText.toLowerCase())) {
                if (label.htmlFor) {
                    input = document.getElementById(label.htmlFor);
                    if (input) return input;
                }
                var container = label.closest('[class*="formField"], [class*="child"], [class*="root"]');
                if (container) {
                    input = container.querySelector('input[type="text"], input:not([type="hidden"]):not([type="checkbox"])');
                    if (input) return input;
                }
                var parent = label.parentElement;
                if (parent) {
                    var sibling = parent.nextElementSibling;
                    while (sibling) {
                        input = sibling.querySelector('input[type="text"], input:not([type="hidden"]):not([type="checkbox"])');
                        if (input) return input;
                        sibling = sibling.nextElementSibling;
                    }
                }
            }
        }
        return null;
    }

    function findButtonByText(text) {
        var buttons = document.querySelectorAll('button');
        for (var i = 0; i < buttons.length; i++) {
            if (buttons[i].textContent.trim().toLowerCase() === text.toLowerCase()) return buttons[i];
        }
        for (var j = 0; j < buttons.length; j++) {
            if (buttons[j].textContent.trim().toLowerCase().includes(text.toLowerCase())) return buttons[j];
        }
        return null;
    }

    async function fillField(labelText, value) {
        var input = await waitForElement(
            function () { return findInputByLabel(labelText); },
            'Input: "' + labelText + '"'
        );
        input.focus();
        await delay(150);
        setNativeValue(input, '');
        await delay(100);
        setNativeValue(input, value);
        await delay(300);
    }

    async function clickBtn(text) {
        var btn = await waitForElement(
            function () { return findButtonByText(text); },
            'Button: "' + text + '"'
        );
        var maxRetries = 20;
        for (var i = 0; i < maxRetries; i++) {
            if (!btn.disabled) { btn.click(); return true; }
            await delay(500);
        }
        return false;
    }

    // ============================================================
    // 🎯 APPROACH B: Arrow + Setter + ArrowDown + Enter
    // For dropdowns WITH search combobox (Category, Reporting Time)
    // ============================================================

    async function selectDropdownWithSearch(triggerFinder, optionText, label) {
        var triggerBtn = triggerFinder();
        if (!triggerBtn) {
            addLog('  ❌ ' + label + ' trigger not found', 'error');
            return false;
        }

        var arrow = triggerBtn.querySelector('span[class*="awsui_arrow"] span[class*="awsui_icon"]');
        if (!arrow) arrow = triggerBtn;

        arrow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        arrow.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        arrow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        addLog('  🔄 ' + label + ' dropdown opening...', 'info');
        await delay(DELAY_DROPDOWN_OPEN);

        var searchInput = null;
        var combos = document.querySelectorAll('input[role="combobox"]');
        for (var c = 0; c < combos.length; c++) {
            if (combos[c].offsetParent !== null) { searchInput = combos[c]; break; }
        }
        if (!searchInput && combos.length > 0) searchInput = combos[combos.length - 1];

        if (!searchInput) {
            addLog('  ❌ ' + label + ' combobox not found', 'error');
            return false;
        }

        searchInput.focus();
        await delay(200);
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(searchInput, optionText);
        searchInput.dispatchEvent(new Event('input', { bubbles: true }));
        searchInput.dispatchEvent(new Event('change', { bubbles: true }));
        addLog('  🔄 Typed "' + optionText + '", filtering...', 'info');
        await delay(DELAY_DROPDOWN_FILTER);

        searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
        await delay(500);
        searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        await delay(800);

        var verifyBtn = triggerFinder();
        if (verifyBtn) {
            var selectedText = verifyBtn.textContent.trim();
            if (selectedText.toLowerCase().includes(optionText.toLowerCase())) {
                addLog('  ✅ ' + label + ': "' + optionText + '" selected', 'success');
                return true;
            } else {
                addLog('  ⚠️ ' + label + ' shows: "' + selectedText + '"', 'warn');
            }
        }
        return true;
    }

    // ============================================================
    // 🎯 CATEGORY SELECT (has search → Approach B)
    // ============================================================

    async function selectCategory(optionText) {
        return await selectDropdownWithSearch(
            function () {
                var container = document.querySelector('[data-testid="category-type-select"]');
                return container ? container.querySelector('button') : null;
            },
            optionText,
            'Category'
        );
    }

    // ============================================================
    // 🎯 CUSTOM DURATION SELECT — WITH RETRY LOGIC
    // Retry up to MAX_CUSTOM_DURATION_RETRIES times.
    // Each failure resets the form via Edit button before retrying.
    // Returns { success: boolean, retriesUsed: number }
    // ============================================================

    async function attemptSelectCustomDuration() {
        // Find the duration trigger button
        var triggerBtn = null;
        var allBtns = document.querySelectorAll('button[class*="button-trigger"]');
        for (var i = 0; i < allBtns.length; i++) {
            var txt = allBtns[i].textContent.trim().toLowerCase();
            if (txt.includes('full day') || txt.includes('half day') || txt.includes('custom')) {
                triggerBtn = allBtns[i];
                break;
            }
        }

        if (!triggerBtn) {
            addLog('  ⚠️ Duration trigger not found', 'warn');
            return false;
        }

        // Already Custom Duration?
        if (triggerBtn.textContent.trim().toLowerCase().includes('custom')) {
            addLog('  ✅ Duration: already "Custom Duration"', 'success');
            return true;
        }

        // Step 1: Focus the button
        triggerBtn.focus();
        await delay(500);

        // Step 2: Press Space to open dropdown
        triggerBtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
        triggerBtn.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
        addLog('  🔄 Duration: Space pressed, opening...', 'info');
        await delay(DELAY_DROPDOWN_OPEN);

        // Step 3: ArrowDown to move to Custom Duration (2nd option)
        var focused = document.activeElement;
        focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
        await delay(500);

        // Step 4: Enter to select
        focused.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        await delay(800);

        // Verify
        var verifyBtn = null;
        allBtns = document.querySelectorAll('button[class*="button-trigger"]');
        for (var v = 0; v < allBtns.length; v++) {
            var vTxt = allBtns[v].textContent.trim().toLowerCase();
            if (vTxt.includes('full day') || vTxt.includes('custom')) {
                verifyBtn = allBtns[v];
                break;
            }
        }

        if (verifyBtn && verifyBtn.textContent.trim().toLowerCase().includes('custom')) {
            addLog('  ✅ Duration: "Custom Duration" selected', 'success');
            return true;
        } else {
            addLog('  ❌ Duration still shows: "' + (verifyBtn ? verifyBtn.textContent.trim() : 'unknown') + '"', 'error');
            return false;
        }
    }

    async function selectCustomDurationWithRetry(record, index, total) {
        for (var attempt = 1; attempt <= MAX_CUSTOM_DURATION_RETRIES; attempt++) {
            var success = await attemptSelectCustomDuration();
            if (success) return true;

            addLog('  🔁 Custom Duration failed (attempt ' + attempt + '/' + MAX_CUSTOM_DURATION_RETRIES + ') — resetting via Edit...', 'warn');

            // Reset the form via Edit
            var editOk = await clickEditToReset();
            if (!editOk) {
                addLog('  ❌ Edit reset failed during retry', 'error');
                return false;
            }

            // If we still have retries left, re-fill the form up to Show Schedule
            if (attempt < MAX_CUSTOM_DURATION_RETRIES) {
                addLog('  🔄 Re-filling form for retry...', 'info');
                try {
                    await fillField('User login', record.login);
                    addLog('  ✅ Login: ' + record.login, 'success');
                    await delay(DELAY_BETWEEN_STEPS);

                    var catOk = await selectCategory(record.category);
                    if (!catOk) throw new Error('Category re-fill failed');
                    await delay(DELAY_BETWEEN_STEPS);

                    await fillField('Start Date', record.startDate);
                    addLog('  ✅ Start Date: ' + record.startDate, 'success');
                    await delay(DELAY_BETWEEN_STEPS);

                    await fillField('End Date', record.endDate);
                    addLog('  ✅ End Date: ' + record.endDate, 'success');
                    await delay(DELAY_BETWEEN_STEPS);

                    await clickBtn('Show Schedule');
                    addLog('  ✅ Show Schedule', 'success');
                    await delay(DELAY_AFTER_SCHEDULE);
                } catch (e) {
                    addLog('  ❌ Re-fill failed: ' + e.message, 'error');
                    return false;
                }
            }
        }

        // All retries exhausted
        addLog('  ❌ Custom Duration failed after ' + MAX_CUSTOM_DURATION_RETRIES + ' attempts — skipping record', 'error');
        return false;
    }

    // ============================================================
    // 🎯 REPORTING TIME SELECT (has search → Approach B)
    // ============================================================

    async function selectReportingTime(timeValue) {
        return await selectDropdownWithSearch(
            function () {
                var allBtns = document.querySelectorAll('button[class*="button-trigger"], button[id*="formField"]');
                for (var i = 0; i < allBtns.length; i++) {
                    var txt = allBtns[i].textContent.trim().toLowerCase();
                    if (txt.includes('select reporting time') || txt.includes('reporting')) {
                        return allBtns[i];
                    }
                }
                return null;
            },
            timeValue,
            'Reporting Time'
        );
    }

    // ============================================================
    // 🔄 CLICK EDIT TO RESET
    // ============================================================

    async function clickEditToReset() {
        try {
            var editBtn = document.querySelector('[data-testid="enter-time-off-edit-button"]');
            if (!editBtn) editBtn = findButtonByText('Edit');
            if (editBtn) {
                editBtn.click();
                addLog('  🔄 Edit clicked → form reset', 'info');
                await delay(DELAY_AFTER_EDIT);
                return true;
            }
            addLog('  ❌ Edit button not found', 'error');
            return false;
        } catch (e) {
            addLog('  ❌ Reset failed: ' + e.message, 'error');
            return false;
        }
    }

    // ============================================================
    // 🎨 UI PANEL
    // ============================================================

    function createPanel() {
        GM_addStyle(
            '#vibe-timeoff-panel{position:fixed;top:60px;right:20px;width:420px;max-height:90vh;background:#1B2838;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.4);z-index:99999;font-family:"Amazon Ember",Arial,sans-serif;color:#E0E0E0;overflow:hidden;display:flex;flex-direction:column}' +
            '#vibe-timeoff-panel .panel-header{background:linear-gradient(135deg,#FF9900,#FF6600);padding:12px 16px;display:flex;justify-content:space-between;align-items:center;cursor:move}' +
            '#vibe-timeoff-panel .panel-header h3{margin:0;font-size:14px;font-weight:700;color:#1B2838;text-transform:uppercase;letter-spacing:.5px}' +
            '#vibe-timeoff-panel .panel-header .controls{display:flex;gap:6px}' +
            '#vibe-timeoff-panel .panel-header .controls button{background:rgba(27,40,56,.3);border:none;color:#1B2838;width:24px;height:24px;border-radius:50%;cursor:pointer;font-size:12px;font-weight:bold;display:flex;align-items:center;justify-content:center}' +
            '#vibe-timeoff-panel .panel-body{padding:14px;overflow-y:auto;flex:1}' +
            '#vibe-timeoff-panel label{display:block;font-size:11px;font-weight:600;color:#FFD700;margin-bottom:4px;text-transform:uppercase;letter-spacing:.3px}' +
            '#vibe-timeoff-panel textarea{width:100%;height:140px;background:#0D1B2A;border:1px solid #2A3F55;border-radius:8px;color:#E0E0E0;font-family:Consolas,monospace;font-size:11px;padding:10px;resize:vertical;box-sizing:border-box;margin-bottom:10px}' +
            '#vibe-timeoff-panel textarea:focus{border-color:#FF9900;outline:none;box-shadow:0 0 0 2px rgba(255,153,0,.2)}' +
            '#vibe-timeoff-panel textarea::placeholder{color:#4A6A8A;font-size:10px}' +
            '#vibe-timeoff-panel .info-box{background:#0D1B2A;border:1px solid #2A3F55;border-radius:8px;padding:10px;margin-bottom:10px;font-size:10px;line-height:1.5}' +
            '#vibe-timeoff-panel .info-box code{background:#1B2838;padding:1px 4px;border-radius:3px;color:#FF9900;font-size:10px}' +
            '#vibe-timeoff-panel .btn-row{display:flex;gap:8px;margin-bottom:10px}' +
            '#vibe-timeoff-panel .btn{flex:1;padding:10px;border:none;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;text-transform:uppercase;letter-spacing:.5px;transition:all .2s}' +
            '#vibe-timeoff-panel .btn-primary{background:linear-gradient(135deg,#FF9900,#FF6600);color:#1B2838}' +
            '#vibe-timeoff-panel .btn-primary:disabled{background:#3A3A3A;color:#666;cursor:not-allowed}' +
            '#vibe-timeoff-panel .btn-danger{background:#CC3333;color:white}' +
            '#vibe-timeoff-panel .btn-secondary{background:#2A3F55;color:#E0E0E0}' +
            '#vibe-timeoff-panel .log-area{background:#0A0F18;border:1px solid #1A2A3A;border-radius:8px;padding:8px;height:200px;overflow-y:auto;font-family:Consolas,monospace;font-size:10px;line-height:1.6}' +
            '#vibe-timeoff-panel .log-area .log-success{color:#4CAF50}' +
            '#vibe-timeoff-panel .log-area .log-error{color:#FF5252}' +
            '#vibe-timeoff-panel .log-area .log-info{color:#64B5F6}' +
            '#vibe-timeoff-panel .log-area .log-warn{color:#FFD700}' +
            '#vibe-timeoff-panel .log-area .log-process{color:#FF9900;font-weight:bold}' +
            '#vibe-timeoff-panel .progress-bar{width:100%;height:6px;background:#0D1B2A;border-radius:3px;margin-bottom:10px;overflow:hidden}' +
            '#vibe-timeoff-panel .progress-fill{height:100%;background:linear-gradient(90deg,#FF9900,#FFD700);border-radius:3px;transition:width .3s;width:0%}' +
            '#vibe-timeoff-panel .stats{display:flex;justify-content:space-around;margin-bottom:10px}' +
            '#vibe-timeoff-panel .stat-item{text-align:center}' +
            '#vibe-timeoff-panel .stat-num{font-size:18px;font-weight:700}' +
            '#vibe-timeoff-panel .stat-label{font-size:9px;color:#7A8A9A;text-transform:uppercase}' +
            '#vibe-timeoff-panel .log-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}' +
            '#vibe-timeoff-panel .log-header label{margin-bottom:0}' +
            '#vibe-timeoff-panel .btn-export{background:#2A3F55;border:none;color:#E0E0E0;padding:4px 10px;border-radius:6px;font-size:10px;font-weight:600;cursor:pointer;text-transform:uppercase;letter-spacing:.3px}' +
            '#vibe-timeoff-panel.minimized .panel-body{display:none}' +
            '#vibe-timeoff-panel .failed-report{background:#1A0A0A;border:1px solid #FF5252;border-radius:8px;padding:10px;margin-top:10px;font-size:11px;line-height:1.6;display:none}' +
            '#vibe-timeoff-panel .failed-report h4{margin:0 0 6px 0;color:#FF5252;font-size:12px}' +
            '#vibe-timeoff-panel .failed-report .failed-item{color:#FFD700;padding:2px 0;border-bottom:1px solid #2A1A1A}' +
            '#vibe-timeoff-panel .failed-report .failed-item:last-child{border-bottom:none}'
        );

        var panel = document.createElement('div');
        panel.id = 'vibe-timeoff-panel';

        var header = document.createElement('div');
        header.className = 'panel-header';
        var title = document.createElement('h3');
        title.textContent = '⚡ Stitch Time Off v1.1';
        header.appendChild(title);
        var controls = document.createElement('div');
        controls.className = 'controls';
        var minBtn = document.createElement('button');
        minBtn.textContent = '—';
        controls.appendChild(minBtn);
        var closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        controls.appendChild(closeBtn);
        header.appendChild(controls);
        panel.appendChild(header);

        var body = document.createElement('div');
        body.className = 'panel-body';

        var infoBox = document.createElement('div');
        infoBox.className = 'info-box';
        infoBox.innerHTML = '📋 <strong>Paste from Excel</strong> (tab-separated):<br><code>login</code> <code>category</code> <code>startDate</code> <code>endDate</code> <code>startTime</code> <code>endTime</code><br>📌 Categories: <code>Infraction</code> or <code>Outage Pending - VCC</code><br>📌 Dates: <code>YYYY/MM/DD</code> | Times: <code>HH:MM</code><br>';
        body.appendChild(infoBox);

        var taLabel = document.createElement('label');
        taLabel.textContent = '📥 Paste data:';
        body.appendChild(taLabel);
        var textarea = document.createElement('textarea');
        textarea.id = 'vibe-data-input';
        textarea.placeholder = 'login\tcategory\tstartDate\tendDate\tstartTime\tendTime';
        body.appendChild(textarea);

        var btnRow1 = document.createElement('div');
        btnRow1.className = 'btn-row';
        var validateBtn = document.createElement('button');
        validateBtn.className = 'btn btn-secondary';
        validateBtn.id = 'vibe-validate';
        validateBtn.textContent = '✔ Validate';
        btnRow1.appendChild(validateBtn);
        var startBtn = document.createElement('button');
        startBtn.className = 'btn btn-primary';
        startBtn.id = 'vibe-start';
        startBtn.textContent = '▶ Process';
        startBtn.disabled = true;
        btnRow1.appendChild(startBtn);
        var stopBtn = document.createElement('button');
        stopBtn.className = 'btn btn-danger';
        stopBtn.id = 'vibe-stop';
        stopBtn.textContent = '■ Stop';
        stopBtn.disabled = true;
        btnRow1.appendChild(stopBtn);
        body.appendChild(btnRow1);

        var progressBar = document.createElement('div');
        progressBar.className = 'progress-bar';
        var progressFill = document.createElement('div');
        progressFill.className = 'progress-fill';
        progressFill.id = 'vibe-progress';
        progressBar.appendChild(progressFill);
        body.appendChild(progressBar);

        var stats = document.createElement('div');
        stats.className = 'stats';
        [
            { id: 'stat-total', label: 'Total', color: '#FF9900' },
            { id: 'stat-done', label: 'Completed', color: '#4CAF50' },
            { id: 'stat-fail', label: 'Failed', color: '#FF5252' },
            { id: 'stat-pending', label: 'Pending', color: '#64B5F6' },
            { id: 'stat-skipped', label: 'Skipped', color: '#FFD700' }
        ].forEach(function (s) {
            var item = document.createElement('div');
            item.className = 'stat-item';
            var num = document.createElement('div');
            num.className = 'stat-num';
            num.id = s.id;
            num.textContent = '0';
            num.style.cssText = 'color:' + s.color;
            var lbl = document.createElement('div');
            lbl.className = 'stat-label';
            lbl.textContent = s.label;
            item.appendChild(num);
            item.appendChild(lbl);
            stats.appendChild(item);
        });
        body.appendChild(stats);

        var logHeader = document.createElement('div');
        logHeader.className = 'log-header';
        var logLabel = document.createElement('label');
        logLabel.textContent = '📜 Log:';
        logHeader.appendChild(logLabel);
        var exportBtn = document.createElement('button');
        exportBtn.className = 'btn-export';
        exportBtn.id = 'vibe-export-log';
        exportBtn.textContent = '📥 Export';
        logHeader.appendChild(exportBtn);
        body.appendChild(logHeader);

        var logArea = document.createElement('div');
        logArea.className = 'log-area';
        logArea.id = 'vibe-log';
        body.appendChild(logArea);

        // Failed records report section
        var failedReport = document.createElement('div');
        failedReport.className = 'failed-report';
        failedReport.id = 'vibe-failed-report';
        body.appendChild(failedReport);

        panel.appendChild(body);
        document.body.appendChild(panel);

        makeDraggable(panel, header);
        minBtn.addEventListener('click', function () { panel.classList.toggle('minimized'); });
        closeBtn.addEventListener('click', function () { panel.style.display = 'none'; });
        validateBtn.addEventListener('click', validateData);
        startBtn.addEventListener('click', startProcessing);
        stopBtn.addEventListener('click', function () { shouldStop = true; addLog('⛔ Stopped', 'warn'); });
        exportBtn.addEventListener('click', exportLog);
    }

    function makeDraggable(element, handle) {
        var offsetX, offsetY, isDragging = false;
        handle.addEventListener('mousedown', function (e) {
            isDragging = true;
            offsetX = e.clientX - element.getBoundingClientRect().left;
            offsetY = e.clientY - element.getBoundingClientRect().top;
            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', function () {
                isDragging = false;
                document.removeEventListener('mousemove', onDrag);
            }, { once: true });
        });
        function onDrag(e) {
            if (!isDragging) return;
            element.style.left = (e.clientX - offsetX) + 'px';
            element.style.top = (e.clientY - offsetY) + 'px';
            element.style.right = 'auto';
        }
    }

    function addLog(message, type) {
        type = type || 'info';
        var logArea = document.getElementById('vibe-log');
        var time = new Date().toLocaleTimeString('en-US', { hour12: false });
        var line = document.createElement('div');
        line.className = 'log-' + type;
        line.textContent = '[' + time + '] ' + message;
        logArea.appendChild(line);
        logArea.scrollTop = logArea.scrollHeight;
    }

    function exportLog() {
        var logArea = document.getElementById('vibe-log');
        var entries = logArea.querySelectorAll('div');
        if (entries.length === 0) { addLog('⚠️ No entries.', 'warn'); return; }
        var csvRows = ['Timestamp,Type,Message'];
        entries.forEach(function (entry) {
            var text = entry.textContent || '';
            var type = (entry.className || '').replace('log-', '').toUpperCase();
            var match = text.match(/^\[([^\]]+)\]\s*(.*)$/);
            csvRows.push((match ? match[1] : '') + ',' + type + ',"' + (match ? match[2] : text).replace(/"/g, '""') + '"');
        });

        // Append failed records summary to CSV
        if (failedRecords.length > 0) {
            csvRows.push('');
            csvRows.push('--- FAILED/SKIPPED RECORDS ---');
            csvRows.push('Row,Login,Category,Reason');
            failedRecords.forEach(function (fr) {
                csvRows.push(fr.row + ',' + fr.login + ',' + fr.category + ',"' + fr.reason.replace(/"/g, '""') + '"');
            });
        }

        var blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
        var url = URL.createObjectURL(blob);
        var fn = 'TimeOff_Log_' + new Date().toISOString().slice(0, 10) + '.csv';
        var link = document.createElement('a');
        link.href = url; link.download = fn; link.style.display = 'none';
        document.body.appendChild(link); link.click(); document.body.removeChild(link);
        URL.revokeObjectURL(url);
        addLog('📥 Exported: ' + fn, 'success');
    }

    // ============================================================
    // 📊 SHOW FAILED RECORDS REPORT
    // ============================================================

    function showFailedReport() {
        var reportDiv = document.getElementById('vibe-failed-report');
        if (failedRecords.length === 0) {
            reportDiv.style.display = 'none';
            return;
        }

        var html = '<h4>⚠️ Failed/Skipped Records (' + failedRecords.length + ')</h4>';
        failedRecords.forEach(function (fr) {
            html += '<div class="failed-item">Row ' + fr.row + ' — <strong>' + fr.login + '</strong> | ' + fr.category + ' | ' + fr.dates + '<br>↳ Reason: ' + fr.reason + '</div>';
        });
        reportDiv.innerHTML = html;
        reportDiv.style.display = 'block';
    }

    // ============================================================
    // ✅ PARSE & VALIDATE
    // ============================================================

    function parseData() {
        var raw = document.getElementById('vibe-data-input').value.trim();
        if (!raw) return [];
        var lines = raw.split('\n').filter(function (l) { return l.trim(); });
        var records = [];
        for (var i = 0; i < lines.length; i++) {
            var cols = lines[i].split('\t');
            if (cols[0].toLowerCase() === 'login') continue;
            if (cols.length < 6) { addLog('⚠️ Row ' + (i + 1) + ' skipped (need 6+ cols)', 'warn'); continue; }
            records.push({
                row: i + 1,
                login: (cols[0] || '').trim(),
                category: (cols[1] || '').trim(),
                startDate: (cols[2] || '').trim(),
                endDate: (cols[3] || '').trim(),
                startTime: (cols[4] || '').trim(),
                endTime: (cols[5] || '').trim(),
                reportingTime: (cols[6] || '').trim(),
                comments: (cols[7] || '').trim()
            });
        }
        return records;
    }

    function validateData() {
        document.getElementById('vibe-log').innerHTML = '';
        document.getElementById('vibe-failed-report').style.display = 'none';
        failedRecords = [];
        var records = parseData();
        if (records.length === 0) { addLog('❌ No records.', 'error'); document.getElementById('vibe-start').disabled = true; return; }
        var hasErrors = false;
        records.forEach(function (r, i) {
            var errors = [];
            if (!r.login) errors.push('login');
            if (r.category !== 'Infraction' && r.category !== 'Outage Pending - VCC') errors.push('category');
            if (!/^\d{4}\/\d{2}\/\d{2}$/.test(r.startDate)) errors.push('startDate');
            if (!/^\d{4}\/\d{2}\/\d{2}$/.test(r.endDate)) errors.push('endDate');
            if (!/^\d{2}:\d{2}$/.test(r.startTime)) errors.push('startTime');
            if (!/^\d{2}:\d{2}$/.test(r.endTime)) errors.push('endTime');
            if (errors.length > 0) { hasErrors = true; addLog('❌ Row ' + r.row + ': ' + errors.join(', '), 'error'); }
            else addLog('✅ Row ' + r.row + ': ' + r.login + ' | ' + r.category + ' | ' + r.startDate + ' | ' + r.startTime + '-' + r.endTime, 'success');
        });
        document.getElementById('stat-total').textContent = records.length;
        document.getElementById('stat-pending').textContent = records.length;
        document.getElementById('stat-done').textContent = '0';
        document.getElementById('stat-fail').textContent = '0';
        document.getElementById('stat-skipped').textContent = '0';
        document.getElementById('vibe-progress').style.width = '0%';
        if (!hasErrors) { addLog('🎯 ' + records.length + ' ready.', 'process'); document.getElementById('vibe-start').disabled = false; }
        else { addLog('⚠️ Fix errors.', 'warn'); document.getElementById('vibe-start').disabled = true; }
    }

    // ============================================================
    // 🚀 PROCESS RECORD
    // ============================================================

    async function processRecord(record, index, total) {
        addLog('━━━ [' + (index + 1) + '/' + total + '] ' + record.login + ' ━━━', 'process');

        try {
            // 1: Login
            await fillField('User login', record.login);
            addLog('  ✅ Login: ' + record.login, 'success');
            await delay(DELAY_BETWEEN_STEPS);

            // 2: Category (Approach B — has search)
            var catOk = await selectCategory(record.category);
            if (!catOk) throw new Error('Category "' + record.category + '" failed');
            await delay(DELAY_BETWEEN_STEPS);

            // 3: Start Date
            await fillField('Start Date', record.startDate);
            addLog('  ✅ Start Date: ' + record.startDate, 'success');
            await delay(DELAY_BETWEEN_STEPS);

            // 4: End Date
            await fillField('End Date', record.endDate);
            addLog('  ✅ End Date: ' + record.endDate, 'success');
            await delay(DELAY_BETWEEN_STEPS);

            // 5: Show Schedule
            await clickBtn('Show Schedule');
            addLog('  ✅ Show Schedule', 'success');
            await delay(DELAY_AFTER_SCHEDULE);

            // 6: Custom Duration — WITH RETRY LOGIC
            var durOk = await selectCustomDurationWithRetry(record, index, total);
            if (!durOk) {
                // Record failed after retries — skip it
                failedRecords.push({
                    row: record.row,
                    login: record.login,
                    category: record.category,
                    dates: record.startDate + ' → ' + record.endDate,
                    reason: 'Custom Duration failed after ' + MAX_CUSTOM_DURATION_RETRIES + ' attempts'
                });
                return 'skipped';
            }
            await delay(DELAY_BETWEEN_STEPS);

            // 7: Start Time
            await fillField('Start Time', record.startTime);
            addLog('  ✅ Start Time: ' + record.startTime, 'success');
            await delay(DELAY_BETWEEN_STEPS);

            // 8: End Time
            await fillField('End Time', record.endTime);
            addLog('  ✅ End Time: ' + record.endTime, 'success');
            await delay(DELAY_BETWEEN_STEPS);

            // 9: Reporting Time (Approach B — has search) — always 01:00
            var rtValue = record.reportingTime || '01:00';
            var rtOk = await selectReportingTime(rtValue);
            if (!rtOk) addLog('  ⚠️ Reporting Time not set', 'warn');
            await delay(DELAY_BETWEEN_STEPS);

            // 10: Comments (optional)
            if (record.comments) {
                var ta = document.querySelector('textarea[placeholder="Add Comments"]');
                if (ta) {
                    ta.focus();
                    var taSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
                    taSetter.call(ta, record.comments);
                    ta.dispatchEvent(new Event('input', { bubbles: true }));
                    ta.dispatchEvent(new Event('change', { bubbles: true }));
                    addLog('  ✅ Comments added', 'success');
                }
                await delay(DELAY_BETWEEN_STEPS);
            }

            // 11: Submit
            await clickBtn('Submit');
            addLog('  🚀 SUBMITTED → ' + record.login, 'success');
            await delay(DELAY_AFTER_SUBMIT);

            return 'success';
        } catch (error) {
            addLog('  💥 ERROR: ' + error.message, 'error');
            failedRecords.push({
                row: record.row,
                login: record.login,
                category: record.category,
                dates: record.startDate + ' → ' + record.endDate,
                reason: error.message
            });
            return 'failed';
        }
    }

    // ============================================================
    // 🔄 PROCESS ALL
    // ============================================================

    async function startProcessing() {
        if (isProcessing) return;
        isProcessing = true;
        shouldStop = false;
        failedRecords = [];
        var records = parseData();
        var total = records.length;
        var done = 0, fail = 0, skipped = 0;
        document.getElementById('vibe-start').disabled = true;
        document.getElementById('vibe-stop').disabled = false;
        document.getElementById('vibe-data-input').disabled = true;
        document.getElementById('vibe-failed-report').style.display = 'none';
        document.getElementById('stat-skipped').textContent = '0';
        addLog('🤖 Processing ' + total + ' record(s)...', 'process');

        for (var i = 0; i < records.length; i++) {
            if (shouldStop) { addLog('⛔ Stopped at ' + (i + 1) + '/' + total, 'warn'); break; }

            var result = await processRecord(records[i], i, total);

            if (result === 'success') {
                done++;
            } else if (result === 'skipped') {
                skipped++;
                addLog('  ⏭️ Skipped → ' + records[i].login + ' (will retry manually)', 'warn');
            } else {
                fail++;
            }

            document.getElementById('stat-done').textContent = done;
            document.getElementById('stat-fail').textContent = fail;
            document.getElementById('stat-skipped').textContent = skipped;
            document.getElementById('stat-pending').textContent = total - done - fail - skipped;
            document.getElementById('vibe-progress').style.width = (((done + fail + skipped) / total) * 100) + '%';

            // Reset via Edit for next record
            if (i < records.length - 1 && !shouldStop) {
                addLog('⏳ Resetting via Edit...', 'info');
                var editOk = await clickEditToReset();
                if (!editOk) { addLog('❌ Reset failed. Stopping.', 'error'); break; }
            }
        }

        // Final summary
        addLog('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', 'process');
        addLog('🏁 DONE: ✅ ' + done + ' | ❌ ' + fail + ' | ⏭️ ' + skipped + ' | Total: ' + total, 'process');

        if (failedRecords.length > 0) {
            addLog('', 'info');
            addLog('⚠️ FAILED/SKIPPED RECORDS:', 'error');
            failedRecords.forEach(function (fr) {
                addLog('  Row ' + fr.row + ': ' + fr.login + ' (' + fr.category + ') — ' + fr.reason, 'error');
            });
            showFailedReport();
        } else {
            addLog('🎉 All records processed successfully!', 'success');
        }

        isProcessing = false;
        document.getElementById('vibe-start').disabled = false;
        document.getElementById('vibe-stop').disabled = true;
        document.getElementById('vibe-data-input').disabled = false;
    }

    // ============================================================
    // 🚀 INIT
    // ============================================================

    setTimeout(function () {
        createPanel();
        addLog('💡 Paste data, Validate, then Process.', 'info');
    }, 2000);

})();
