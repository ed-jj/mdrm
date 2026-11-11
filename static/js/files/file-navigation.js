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
 * Previous / next file navigation for Metadata Remote.
 * Steps through the files of the selected folder in the order shown in the
 * Files list (so it follows the current sort and filter). If the panel has
 * unsaved edits, asks whether to save them first.
 */

(function() {
    window.MetadataRemote = window.MetadataRemote || {};
    window.MetadataRemote.Files = window.MetadataRemote.Files || {};

    const State = window.MetadataRemote.State;

    let busy = false;
    let promptResolve = null;
    let promptKeyHandler = null;
    let promptReturnFocus = null;

    function fileItems() {
        return Array.from(document.querySelectorAll('#file-list li[data-filepath]'));
    }

    function currentIndex(items) {
        if (!State.currentFile) return -1;
        return items.findIndex(li => li.dataset.filepath === State.currentFile);
    }

    /**
     * Show the unsaved changes prompt.
     * @returns {Promise<'save'|'discard'|'cancel'>}
     */
    function askUnsaved() {
        const overlay = document.getElementById('unsaved-overlay');
        const box = document.getElementById('unsaved-box');
        const text = document.getElementById('unsaved-text');
        if (!overlay || !box) return Promise.resolve('discard');

        const filename = State.currentFile ? State.currentFile.split('/').pop() : 'this file';
        text.textContent = `Save your changes to "${filename}" before moving on?`;

        promptReturnFocus = document.activeElement;
        overlay.classList.add('active');
        box.classList.add('active');

        return new Promise(resolve => {
            promptResolve = resolve;

            const buttons = [
                document.getElementById('unsaved-save'),
                document.getElementById('unsaved-discard'),
                document.getElementById('unsaved-cancel')
            ];

            promptKeyHandler = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    closePrompt('cancel');
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Tab') {
                    // Keep focus inside the prompt
                    e.preventDefault();
                    e.stopPropagation();
                    const idx = buttons.indexOf(document.activeElement);
                    const back = e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey);
                    const next = idx === -1 ? 0 : (idx + (back ? buttons.length - 1 : 1)) % buttons.length;
                    buttons[next].focus();
                } else if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (buttons.includes(document.activeElement)) {
                        document.activeElement.click();
                    }
                }
            };
            document.addEventListener('keydown', promptKeyHandler, true);

            buttons[0].focus();
        });
    }

    function closePrompt(choice) {
        document.getElementById('unsaved-overlay')?.classList.remove('active');
        document.getElementById('unsaved-box')?.classList.remove('active');
        if (promptKeyHandler) {
            document.removeEventListener('keydown', promptKeyHandler, true);
            promptKeyHandler = null;
        }
        if (choice === 'cancel' && promptReturnFocus && document.body.contains(promptReturnFocus)) {
            promptReturnFocus.focus();
        }
        promptReturnFocus = null;
        if (promptResolve) {
            const resolve = promptResolve;
            promptResolve = null;
            resolve(choice);
        }
    }

    window.MetadataRemote.Files.Navigation = {
        init() {
            document.getElementById('unsaved-save')?.addEventListener('click', () => closePrompt('save'));
            document.getElementById('unsaved-discard')?.addEventListener('click', () => closePrompt('discard'));
            document.getElementById('unsaved-cancel')?.addEventListener('click', () => closePrompt('cancel'));
            document.getElementById('unsaved-overlay')?.addEventListener('click', () => closePrompt('cancel'));

            // Keep the buttons' enabled state in step with the file list and current file
            const Manager = window.MetadataRemote.Files.Manager;
            if (Manager) {
                const originalRender = Manager.renderFileList;
                Manager.renderFileList = function(...args) {
                    const result = originalRender.apply(this, args);
                    window.MetadataRemote.Files.Navigation.updateButtons();
                    return result;
                };
                const originalLoadFile = Manager.loadFile;
                Manager.loadFile = function(...args) {
                    const result = originalLoadFile.apply(this, args);
                    window.MetadataRemote.Files.Navigation.updateButtons();
                    Promise.resolve(result).finally(() => window.MetadataRemote.Files.Navigation.updateButtons());
                    return result;
                };
            }

            this.updateButtons();
        },

        /**
         * Enable / disable the previous and next buttons
         */
        updateButtons() {
            const items = fileItems();
            const idx = currentIndex(items);
            const hasPrev = idx > 0;
            const hasNext = idx !== -1 && idx < items.length - 1;
            // A class rather than the disabled attribute: other code re-enables all buttons
            const setState = (btn, enabled) => {
                btn.classList.toggle('nav-disabled', !enabled);
                btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
            };
            document.querySelectorAll('.file-prev-btn').forEach(btn => setState(btn, hasPrev && !busy));
            document.querySelectorAll('.file-next-btn').forEach(btn => setState(btn, hasNext && !busy));
        },

        /**
         * Move to the previous (-1) or next (+1) file in the folder
         * @param {number} direction
         */
        async step(direction) {
            if (busy) return;

            const items = fileItems();
            const idx = currentIndex(items);
            const target = idx === -1 ? null : items[idx + direction];
            if (!target) {
                this.updateButtons();
                return;
            }

            busy = true;
            try {
                const Editor = window.MetadataRemote.Metadata.Editor;
                if (Editor && Editor.hasUnsavedChanges && Editor.hasUnsavedChanges()) {
                    const choice = await askUnsaved();
                    if (choice === 'cancel') {
                        return;
                    }
                    if (choice === 'save') {
                        const saved = await Editor.save(window.MetadataRemote.UI.ButtonStatus.showButtonStatus);
                        if (!saved) {
                            // Stay on this file so nothing is lost
                            window.MetadataRemote.UI.Utilities.showStatus('Changes could not be saved', 'error');
                            return;
                        }
                    }
                }

                // The list may have been re-rendered while the prompt was open
                const freshTarget = fileItems().find(li => li.dataset.filepath === target.dataset.filepath);
                if (!freshTarget) return;

                freshTarget.scrollIntoView({ block: 'nearest' });
                await window.MetadataRemote.Files.Manager.loadFile(freshTarget.dataset.filepath, freshTarget);
            } finally {
                busy = false;
                this.updateButtons();
            }
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => window.MetadataRemote.Files.Navigation.init());
    } else {
        window.MetadataRemote.Files.Navigation.init();
    }
})();
