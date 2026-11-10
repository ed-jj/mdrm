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
 * ReplayGain Module for Metadata Remote
 * Calculates track + album ReplayGain (EBU R128, -18 LUFS reference) for all
 * files in the current folder - treated as one album - and writes the
 * REPLAYGAIN_TRACK_GAIN / _PEAK and REPLAYGAIN_ALBUM_GAIN / _PEAK tags.
 */

(function() {
    window.MetadataRemote = window.MetadataRemote || {};
    window.MetadataRemote.Metadata = window.MetadataRemote.Metadata || {};

    const State = window.MetadataRemote.State;
    const API = window.MetadataRemote.API;
    const ButtonStatus = window.MetadataRemote.UI.ButtonStatus;

    const POLL_INTERVAL = 700;
    const DEFAULT_LABEL = 'Calculate ReplayGain (folder)';

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

    window.MetadataRemote.Metadata.ReplayGain = {
        /**
         * Start the calculation. First click arms the button, second click confirms.
         */
        async run() {
            if (!State.currentFile || running) return;

            const button = document.querySelector('.replaygain-btn');
            if (!button) return;
            const label = button.querySelector('.btn-status-content');

            if (!button.classList.contains('confirming')) {
                button.classList.add('confirming');
                if (label) label.textContent = 'Click again to start';
                setStatus('Writes 4 ReplayGain tags to every file in this folder', '');
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
                const start = await API.startReplayGain(folderPath);
                const jobId = start.jobId;
                let job = null;

                // Poll until the background job finishes
                while (true) {
                    await sleep(POLL_INTERVAL);
                    job = await API.getReplayGainStatus(jobId);
                    if (job.status !== 'running') break;

                    if (job.stage === 'analysing') {
                        setStatus(`Analysing ${job.progress}/${job.total} files...`, '');
                    } else if (job.stage === 'writing') {
                        setStatus(`Writing tags ${job.progress}/${job.total}...`, '');
                    }
                }

                const result = job.result || {};
                const errors = result.errors || [];
                if (errors.length) {
                    console.error('ReplayGain errors:', errors);
                }

                if (job.status === 'done') {
                    const fileWord = result.filesUpdated === 1 ? 'file' : 'files';
                    let text = `Album gain ${result.albumGain}, peak ${result.albumPeak} - ${result.filesUpdated}/${result.filesTotal} ${fileWord} tagged`;
                    if (errors.length) {
                        text += ` (${errors.length} error${errors.length === 1 ? '' : 's'}: ${errors[0]})`;
                    }
                    setStatus(text, errors.length ? 'warning' : 'success');
                    ButtonStatus.showButtonStatus(button, 'Done!', errors.length ? 'warning' : 'success', 3000);
                } else {
                    let text = job.message || 'ReplayGain calculation failed';
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
                console.error('ReplayGain error:', err);
                setStatus(err.message || 'ReplayGain calculation failed', 'error');
                ButtonStatus.showButtonStatus(button, 'Failed', 'error', 3000);
            }

            running = false;
            button.disabled = false;
        }
    };
})();
