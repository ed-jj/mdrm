/*
 * Metadata Remote - Intelligent audio metadata editor
 * Copyright (C) 2025 Dr. William Nelson Leonard
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Dynamic Range Module for Metadata Remote
 * Measures the DR of every file in the current folder (one album), like
 * foobar2000's foo_dynamic_range: writes the DYNAMIC RANGE and
 * ALBUM DYNAMIC RANGE tags and a foo_dr.txt log in the folder.
 * Results are shown in the same status line as ReplayGain.
 */

(function() {
    window.MetadataRemote = window.MetadataRemote || {};
    window.MetadataRemote.Metadata = window.MetadataRemote.Metadata || {};

    const State = window.MetadataRemote.State;
    const ButtonStatus = window.MetadataRemote.UI.ButtonStatus;

    const POLL_INTERVAL = 700;
    const DEFAULT_LABEL = 'Calculate DR (folder)';

    let running = false;

    function setStatus(text, type) {
        const el = document.getElementById('replaygain-status');
        if (!el) return;
        el.textContent = text || '';
        el.className = 'replaygain-status' + (type ? ` ${type}` : '');
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function postJson(url, body) {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || data.message || 'Request failed');
        return data;
    }

    async function getJson(url) {
        const res = await fetch(url);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Request failed');
        return data;
    }

    window.MetadataRemote.Metadata.DynamicRange = {
        /**
         * Start the measurement. First click arms the button, second click confirms.
         */
        async run() {
            if (!State.currentFile || running) return;

            const button = document.querySelector('.dr-btn');
            if (!button) return;
            const label = button.querySelector('.btn-status-content');

            if (!button.classList.contains('confirming')) {
                button.classList.add('confirming');
                if (label) label.textContent = 'Click again to start';
                setStatus('Writes DR tags to every file in this folder and saves foo_dr.txt', '');
                button._confirmTimeout = setTimeout(() => {
                    button.classList.remove('confirming');
                    if (label) label.textContent = DEFAULT_LABEL;
                    setStatus('', '');
                }, 4000);
                return;
            }

            clearTimeout(button._confirmTimeout);
            button.classList.remove('confirming');
            if (label) label.textContent = DEFAULT_LABEL;

            const folderPath = State.currentFile.substring(0, State.currentFile.lastIndexOf('/'));
            const fileAtStart = State.currentFile;

            running = true;
            button.disabled = true;
            ButtonStatus.showButtonStatus(button, 'Working...', 'processing', 0);
            setStatus('Starting...', '');

            try {
                const start = await postJson('/dynamic-range', { folderPath });
                let job = null;

                while (true) {
                    await sleep(POLL_INTERVAL);
                    job = await getJson(`/dynamic-range/${encodeURIComponent(start.jobId)}`);
                    if (job.status !== 'running') break;
                    if (job.stage === 'analysing') {
                        setStatus(`Measuring ${job.progress}/${job.total} files...`, '');
                    } else if (job.stage === 'writing') {
                        setStatus(`Writing tags ${job.progress}/${job.total}...`, '');
                    }
                }

                const result = job.result || {};
                const errors = result.errors || [];
                if (errors.length) console.error('DR errors:', errors);

                if (job.status === 'done') {
                    const tracks = (result.tracks || []).map(t => `DR${t.dr}`).join(' ');
                    let text = `Album DR${result.albumDR}` + (tracks ? ` (tracks: ${tracks})` : '') +
                        ` - ${result.filesUpdated}/${result.filesTotal} files tagged` +
                        (result.logWritten ? ', foo_dr.txt saved' : '');
                    if (errors.length) {
                        text += ` (${errors.length} error${errors.length === 1 ? '' : 's'}: ${errors[0]})`;
                    }
                    setStatus(text, errors.length ? 'warning' : 'success');
                    ButtonStatus.showButtonStatus(button, 'Done!', errors.length ? 'warning' : 'success', 3000);
                } else {
                    let text = job.message || 'DR calculation failed';
                    if (errors.length) text += `: ${errors[0]}`;
                    setStatus(text, 'error');
                    ButtonStatus.showButtonStatus(button, 'Failed', 'error', 3000);
                }

                // Refresh history, and the current file so the new tags show up
                if (window.MetadataRemote.History && window.MetadataRemote.History.Manager &&
                    window.MetadataRemote.History.Manager.loadHistory) {
                    window.MetadataRemote.History.Manager.loadHistory();
                }
                if (State.currentFile === fileAtStart && window.MetadataRemote.Files && window.MetadataRemote.Files.Manager) {
                    window.MetadataRemote.Files.Manager.loadFile(State.currentFile, State.selectedListItem);
                }
            } catch (err) {
                console.error('DR error:', err);
                setStatus(err.message || 'DR calculation failed', 'error');
                ButtonStatus.showButtonStatus(button, 'Failed', 'error', 3000);
            }

            running = false;
            button.disabled = false;
        }
    };
})();
