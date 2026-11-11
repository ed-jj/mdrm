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
 * Mobile layout for Metadata Remote.
 * On narrow screens (see MOBILE_QUERY, matching the CSS) the three columns are
 * shown one at a time, switched with a bottom tab bar. Tapping a folder that
 * contains audio files opens the Files tab; tapping a file opens the Tags tab.
 * The desktop layout is untouched - everything here is driven by
 * body[data-mobile-tab] and CSS inside the matching media query.
 */

(function() {
    window.MetadataRemote = window.MetadataRemote || {};
    window.MetadataRemote.UI = window.MetadataRemote.UI || {};

    const State = window.MetadataRemote.State;
    const MOBILE_QUERY = '(max-width: 900px)';
    const TABS = ['folders', 'files', 'tags'];

    let mediaQuery = null;
    let lastFolderTap = 0;

    function isMobile() {
        return !!(mediaQuery && mediaQuery.matches);
    }

    function currentTab() {
        return document.body.dataset.mobileTab || 'folders';
    }

    window.MetadataRemote.UI.MobileLayout = {
        init() {
            mediaQuery = window.matchMedia(MOBILE_QUERY);

            // Tab bar
            document.querySelectorAll('.mobile-tab').forEach(btn => {
                btn.addEventListener('click', () => this.setTab(btn.dataset.tab));
            });

            // Back button in the breadcrumb bar
            document.getElementById('mobile-back')?.addEventListener('click', () => {
                const tab = currentTab();
                if (tab === 'tags') this.setTab('files');
                else if (tab === 'files') this.setTab('folders');
            });

            // Remember folder taps, so we only auto-advance on a real tap (not keyboard browsing)
            document.getElementById('folder-tree')?.addEventListener('click', (e) => {
                if (e.target.closest('.tree-item-content') && !e.target.closest('input')) {
                    lastFolderTap = Date.now();
                }
            }, true);

            // Tapping a file opens the Tags tab
            document.getElementById('file-list')?.addEventListener('click', (e) => {
                const li = e.target.closest('li[data-filepath]');
                if (li && !e.target.closest('.play-button') && isMobile()) {
                    this.setTab('tags');
                }
            });

            // Hook into file loading to auto-advance and keep the breadcrumb current
            const Manager = window.MetadataRemote.Files && window.MetadataRemote.Files.Manager;
            if (Manager) {
                const originalLoadFiles = Manager.loadFiles;
                Manager.loadFiles = async function(...args) {
                    const result = await originalLoadFiles.apply(this, args);
                    const MobileLayout = window.MetadataRemote.UI.MobileLayout;
                    const tapped = Date.now() - lastFolderTap < 3000;
                    lastFolderTap = 0;
                    if (isMobile() && tapped && currentTab() === 'folders' &&
                        State.currentFiles && State.currentFiles.length > 0) {
                        MobileLayout.setTab('files');
                    } else {
                        MobileLayout.updateCrumb();
                    }
                    return result;
                };
                const originalLoadFile = Manager.loadFile;
                Manager.loadFile = function(...args) {
                    const result = originalLoadFile.apply(this, args);
                    Promise.resolve(result).finally(() => window.MetadataRemote.UI.MobileLayout.updateCrumb());
                    return result;
                };
            }

            // Pick a sensible tab when switching into the mobile layout
            const onChange = () => {
                if (isMobile()) {
                    this.setTab(State.currentFile ? 'tags' : (State.currentPath ? 'files' : 'folders'));
                }
            };
            if (mediaQuery.addEventListener) {
                mediaQuery.addEventListener('change', onChange);
            } else if (mediaQuery.addListener) {
                mediaQuery.addListener(onChange);
            }

            this.setTab('folders');
        },

        /**
         * Show one of the three panels (mobile only; harmless on desktop)
         * @param {'folders'|'files'|'tags'} tab
         */
        setTab(tab) {
            if (!TABS.includes(tab)) return;
            document.body.dataset.mobileTab = tab;

            document.querySelectorAll('.mobile-tab').forEach(btn => {
                const active = btn.dataset.tab === tab;
                btn.classList.toggle('active', active);
                btn.setAttribute('aria-current', active ? 'page' : 'false');
            });

            if (isMobile()) {
                State.focusedPane = tab === 'tags' ? 'metadata' : tab;
            }

            this.updateCrumb();
        },

        /**
         * Update the "‹ Back | where you are" bar
         */
        updateCrumb() {
            const back = document.getElementById('mobile-back');
            const path = document.getElementById('mobile-crumb-path');
            if (!back || !path) return;

            const tab = currentTab();
            if (tab === 'files') {
                back.textContent = '‹ Folders';
                path.textContent = State.currentPath ? State.currentPath.split('/').join(' › ') : 'No folder selected';
            } else if (tab === 'tags') {
                back.textContent = '‹ Files';
                path.textContent = State.currentFile ? State.currentFile.split('/').pop() : 'No file selected';
            } else {
                back.textContent = '';
                path.textContent = '';
            }
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => window.MetadataRemote.UI.MobileLayout.init());
    } else {
        window.MetadataRemote.UI.MobileLayout.init();
    }
})();
