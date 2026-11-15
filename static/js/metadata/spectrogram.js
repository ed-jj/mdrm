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
 * Spectrogram button: opens the current file's spectrogram in a new tab.
 * Only shown when the server's ffmpeg can render spectrograms.
 */

(function() {
    window.MetadataRemote = window.MetadataRemote || {};
    window.MetadataRemote.Metadata = window.MetadataRemote.Metadata || {};

    const State = window.MetadataRemote.State;

    window.MetadataRemote.Metadata.Spectrogram = {
        init() {
            fetch('/capabilities', { credentials: 'same-origin' })
                .then(res => res.ok ? res.json() : {})
                .then(caps => {
                    if (caps && caps.spectrogram) {
                        document.querySelectorAll('.spectrogram-btn').forEach(btn => {
                            btn.style.display = '';
                        });
                    }
                })
                .catch(() => {});
        },

        /** Open the spectrogram of the current file in a new tab */
        open() {
            if (!State.currentFile) return;
            const path = State.currentFile.split('/').map(encodeURIComponent).join('/');
            window.open(`/spectrogram/${path}`, '_blank', 'noopener');
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => window.MetadataRemote.Metadata.Spectrogram.init());
    } else {
        window.MetadataRemote.Metadata.Spectrogram.init();
    }
})();
