/**
 * Johns Hopkins Medicine - Global Assets Portal (/js/site.js)
 *
 * Dynamic Asset Discovery Engine:
 * 1. Azure Blob Storage Live XML Listing (?restype=container&comp=list)
 *    Automatically parses blobs inside:
 *      - css/cdn/{library}/{version}/{file}
 *      - js/cdn/{library}/{version}/{file}
 * 2. Local Dev Server Folder Auto-Crawler
 *    When running locally (e.g., VS Code Live Server / localhost), crawls
 *    /css/cdn/ and /js/cdn/ directory listings automatically so newly added
 *    files appear immediately on refresh.
 * 3. Built-in Fallback Manifest (for offline / file:// protocol).
 */

(function () {
	'use strict';

	const DEFAULT_AZURE_CONTAINER_URL = 'https://jhmcdn.blob.core.windows.net/global-assets';

	// Matches paths like: css/cdn/font-awesome/5.3/all.min.css or js/cdn/jquery/4.1/jquery.min.js
	// Also supports deeper nested paths inside a version folder (e.g. css/cdn/font-awesome/5.3/css/all.min.css)
	const CDN_PATH_REGEX = /^\/?(css|js)\/cdn\/([^/]+)\/([^/]+)\/(.+)$/i;

	// Fallback manifest if opened via file:// offline and Azure has no CDN files yet
	const FALLBACK_PATHS = [
		{ path: 'css/cdn/font-awesome/4.1/font-awesome.min.css', size: 125, lastModified: null },
		{ path: 'css/cdn/font-awesome/5.3/all.min.css', size: 224, lastModified: null },
		{ path: 'js/cdn/jquery/4.1/jquery.min.js', size: 112, lastModified: null },
		{ path: 'js/cdn/jquery/5.3/jquery.min.js', size: 112, lastModified: null }
	];

	// Application State
	const state = {
		libraries: [],          // Grouped libraries [{ id, type, name, versions: [{ version, files: [...] }], selectedVersion }]
		activeFilter: 'all',    // 'all' | 'js' | 'css'
		searchQuery: '',
		baseUrl: DEFAULT_AZURE_CONTAINER_URL,
		sourceMode: 'auto',     // 'auto' | 'azure' | 'local'
		activeSourceLabel: ''
	};

	// DOM Elements
	const els = {
		searchInput: document.getElementById('searchInput'),
		filterTabs: document.querySelectorAll('.filter-tab'),
		countAll: document.getElementById('countAll'),
		countJs: document.getElementById('countJs'),
		countCss: document.getElementById('countCss'),
		sourceModeSelect: document.getElementById('sourceModeSelect'),
		baseUrlInput: document.getElementById('baseUrlInput'),
		sourceStatusDot: document.getElementById('sourceStatusDot'),
		sourceStatusText: document.getElementById('sourceStatusText'),
		refreshBtn: document.getElementById('refreshBtn'),
		themeToggleBtn: document.getElementById('themeToggleBtn'),
		themeIconSun: document.getElementById('themeIconSun'),
		themeIconMoon: document.getElementById('themeIconMoon'),
		resultsSummaryText: document.getElementById('resultsSummaryText'),
		loadingState: document.getElementById('loadingState'),
		emptyState: document.getElementById('emptyState'),
		emptyStateTitle: document.getElementById('emptyStateTitle'),
		emptyStateDesc: document.getElementById('emptyStateDesc'),
		resetFiltersBtn: document.getElementById('resetFiltersBtn'),
		librariesGrid: document.getElementById('librariesGrid'),
		toastContainer: document.getElementById('toastContainer')
	};

	/* ==========================================================================
	   Initialization
	   ========================================================================== */
	function init() {
		initTheme();
		initBaseUrl();
		bindEvents();
		discoverAssets();
	}

	function initTheme() {
		const savedTheme = localStorage.getItem('jhm_assets_theme');
		const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
		const theme = savedTheme || (prefersDark ? 'dark' : 'light');
		applyTheme(theme);
	}

	function applyTheme(theme) {
		document.documentElement.setAttribute('data-theme', theme);
		localStorage.setItem('jhm_assets_theme', theme);
		if (theme === 'dark') {
			els.themeIconSun.hidden = false;
			els.themeIconMoon.hidden = true;
		} else {
			els.themeIconSun.hidden = true;
			els.themeIconMoon.hidden = false;
		}
	}

	function initBaseUrl() {
		// If hosted directly on Azure Blob Storage, derive container base URL from window.location
		const loc = window.location;
		if (loc.hostname.includes('blob.core.windows.net')) {
			const parts = loc.pathname.split('/').filter(Boolean);
			if (parts.length > 0) {
				state.baseUrl = `${loc.origin}/${parts[0]}`;
				els.baseUrlInput.value = state.baseUrl;
			}
		}
	}

	function bindEvents() {
		// Live Search
		els.searchInput.addEventListener('input', (e) => {
			state.searchQuery = e.target.value.trim().toLowerCase();
			render();
		});

		// Keyboard shortcut '/' to focus search
		document.addEventListener('keydown', (e) => {
			if (e.key === '/' && document.activeElement !== els.searchInput && document.activeElement !== els.baseUrlInput) {
				e.preventDefault();
				els.searchInput.focus();
			}
		});

		// Category Filter Tabs
		els.filterTabs.forEach((tab) => {
			tab.addEventListener('click', () => {
				els.filterTabs.forEach((t) => {
					t.classList.remove('active');
					t.setAttribute('aria-selected', 'false');
				});
				tab.classList.add('active');
				tab.setAttribute('aria-selected', 'true');
				state.activeFilter = tab.dataset.filter;
				render();
			});
		});

		// Source Mode Change
		els.sourceModeSelect.addEventListener('change', (e) => {
			state.sourceMode = e.target.value;
			discoverAssets();
		});

		// Base URL Change
		els.baseUrlInput.addEventListener('input', (e) => {
			state.baseUrl = e.target.value.trim().replace(/\/+$/, '');
			render();
		});

		// Sync / Refresh Button
		els.refreshBtn.addEventListener('click', () => {
			discoverAssets(true);
		});

		// Reset Filters Button
		els.resetFiltersBtn.addEventListener('click', () => {
			state.searchQuery = '';
			state.activeFilter = 'all';
			els.searchInput.value = '';
			els.filterTabs.forEach((t) => {
				const isAll = t.dataset.filter === 'all';
				t.classList.toggle('active', isAll);
				t.setAttribute('aria-selected', isAll ? 'true' : 'false');
			});
			render();
		});

		// Theme Toggle
		els.themeToggleBtn.addEventListener('click', () => {
			const current = document.documentElement.getAttribute('data-theme');
			applyTheme(current === 'dark' ? 'light' : 'dark');
		});
	}

	/* ==========================================================================
	   Dynamic Asset Discovery Engine (Azure Live XML + Local Folder Crawler)
	   ========================================================================== */
	async function discoverAssets(isManualRefresh = false) {
		setLoading(true);
		updateStatus('connecting', 'Scanning repository...');

		const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
		const isFileProtocol = window.location.protocol === 'file:';

		let items = [];
		let sourceUsed = '';

		try {
			if (state.sourceMode === 'azure') {
				items = await fetchFromAzureBlobXml(state.baseUrl);
				sourceUsed = 'Azure Blob Live';
			} else if (state.sourceMode === 'local') {
				items = await crawlLocalCdnDirectories();
				sourceUsed = 'Local /cdn/ Folders';
			} else {
				// 'auto' mode:
				// 1. If running on localhost dev server, try crawling local /css/cdn and /js/cdn first
				//    so newly added local files show up immediately!
				if (isLocalhost) {
					items = await crawlLocalCdnDirectories();
					if (items.length > 0) {
						sourceUsed = 'Local Dev Server (/cdn/)';
					}
				}

				// 2. Try Azure Blob Live XML
				if (items.length === 0) {
					const azureItems = await fetchFromAzureBlobXml(state.baseUrl);
					if (azureItems.length > 0) {
						items = azureItems;
						sourceUsed = 'Azure Blob Live';
					}
				}

				// 3. If Azure container currently only has index.html (no /cdn/ files uploaded yet)
				//    and we're on localhost/file, try local or fallback demo data so UI isn't blank
				if (items.length === 0 && !isLocalhost && !isFileProtocol) {
					sourceUsed = 'Azure Blob Live (0 CDN files uploaded yet)';
				} else if (items.length === 0) {
					items = FALLBACK_PATHS;
					sourceUsed = 'Local Fallback Preview';
				}
			}
		} catch (err) {
			console.warn('Discovery warning:', err);
			if (items.length === 0) {
				items = FALLBACK_PATHS;
				sourceUsed = 'Fallback Preview';
			}
		}

		state.libraries = groupAssetsIntoLibraries(items);
		state.activeSourceLabel = sourceUsed;

		const isAzure = sourceUsed.includes('Azure');
		updateStatus(isAzure ? 'online' : 'local', sourceUsed);
		setLoading(false);
		render();

		if (isManualRefresh) {
			showToast(`Synced ${countTotalFiles(state.libraries)} asset files from ${sourceUsed}`);
		}
	}

	/**
	 * Tier 1: Fetch and parse Azure Blob Storage Container XML Listing
	 * Supports Azure pagination via <NextMarker>
	 */
	async function fetchFromAzureBlobXml(containerBaseUrl) {
		const cleanBase = (containerBaseUrl || DEFAULT_AZURE_CONTAINER_URL).replace(/\/+$/, '');
		const discovered = [];
		let marker = '';

		do {
			const listUrl = `${cleanBase}?restype=container&comp=list${marker ? `&marker=${encodeURIComponent(marker)}` : ''}&_t=${Date.now()}`;
			const response = await fetch(listUrl, { method: 'GET' });
			if (!response.ok) {
				throw new Error(`Azure list returned HTTP ${response.status}`);
			}

			const xmlText = await response.text();
			// Strip UTF-8 BOM if present before XML declaration
			const cleanXml = xmlText.replace(/^\uFEFF/, '').trim();
			const parser = new DOMParser();
			const xmlDoc = parser.parseFromString(cleanXml, 'application/xml');

			const blobNodes = xmlDoc.querySelectorAll('Blobs > Blob');
			blobNodes.forEach((blobNode) => {
				const nameNode = blobNode.querySelector('Name');
				if (!nameNode) return;

				const blobPath = nameNode.textContent.trim();
				// Only include files inside css/cdn/* or js/cdn/*
				if (CDN_PATH_REGEX.test(blobPath)) {
					const lengthNode = blobNode.querySelector('Properties > Content-Length');
					const modNode = blobNode.querySelector('Properties > Last-Modified');
					discovered.push({
						path: blobPath.replace(/^\/+/, ''),
						size: lengthNode ? parseInt(lengthNode.textContent, 10) : null,
						lastModified: modNode ? modNode.textContent : null
					});
				}
			});

			const nextMarkerNode = xmlDoc.querySelector('NextMarker');
			marker = nextMarkerNode && nextMarkerNode.textContent ? nextMarkerNode.textContent.trim() : '';
		} while (marker);

		return discovered;
	}

	/**
	 * Tier 2: Auto-crawl local dev server directory listings (/css/cdn/ and /js/cdn/)
	 * Works automatically with VS Code Live Server, Python http.server, npx serve, IIS/Apache directory browsing
	 */
	async function crawlLocalCdnDirectories() {
		const roots = ['css/cdn/', 'js/cdn/'];
		const discovered = [];

		for (const root of roots) {
			try {
				const files = await crawlDirectoryRecursive(root, 0);
				discovered.push(...files);
			} catch (_) {
				// Ignore if directory doesn't exist or server doesn't list directories
			}
		}

		// Also check if a manifest exists at js/assets-manifest.json
		if (discovered.length === 0) {
			try {
				const res = await fetch(`js/assets-manifest.json?_t=${Date.now()}`);
				if (res.ok) {
					const manifest = await res.json();
					if (Array.isArray(manifest)) {
						return manifest.map((item) => (typeof item === 'string' ? { path: item } : item));
					}
				}
			} catch (_) {
				// Ignore
			}
		}

		return discovered;
	}

	async function crawlDirectoryRecursive(dirPath, depth) {
		if (depth > 4) return [];
		const res = await fetch(dirPath);
		if (!res.ok) return [];

		const contentType = res.headers.get('content-type') || '';
		if (!contentType.includes('text/html')) return [];

		const html = await res.text();
		const parser = new DOMParser();
		const doc = parser.parseFromString(html, 'text/html');
		const links = Array.from(doc.querySelectorAll('a[href]'));

		const results = [];
		for (const a of links) {
			const rawHref = a.getAttribute('href');
			if (!rawHref || rawHref === '../' || rawHref === './' || rawHref.startsWith('?') || rawHref.startsWith('#')) {
				continue;
			}

			// Resolve relative path cleanly
			const resolvedUrl = new URL(rawHref, new URL(dirPath, window.location.origin + window.location.pathname));
			let relPath = resolvedUrl.pathname.replace(/^\/+/, '');

			// Normalize if nested under workspace subpath
			const matchIdx = relPath.search(/(css|js)\/cdn\//i);
			if (matchIdx > 0) {
				relPath = relPath.slice(matchIdx);
			}

			// Avoid parent links
			if (!relPath.startsWith(dirPath.replace(/^\/+/, ''))) {
				continue;
			}

			// Check if this link represents a directory or a file
			// Note: Version folders like "4.7" or "5.3.1" contain dots, so we only treat
			// the last path segment as a file if it ends with a known asset extension!
			const lastSegment = relPath.replace(/\/+$/, '').split('/').pop() || '';
			const isKnownAssetFile = /\.(js|mjs|cjs|css|map|woff2?|ttf|eot|svg|otf|json|png|jpg|jpeg|gif|webp|ico)$/i.test(lastSegment);

			if (rawHref.endsWith('/') || !isKnownAssetFile) {
				const subDir = relPath.endsWith('/') ? relPath : `${relPath}/`;
				const subFiles = await crawlDirectoryRecursive(subDir, depth + 1);
				results.push(...subFiles);
			} else if (CDN_PATH_REGEX.test(relPath)) {
				results.push({
					path: relPath,
					size: null,
					lastModified: null
				});
			}
		}
		return results;
	}

	/* ==========================================================================
	   Grouping & Sorting Logic
	   ========================================================================== */
	function groupAssetsIntoLibraries(items) {
		const libMap = new Map();

		items.forEach((item) => {
			const normalizedPath = item.path.replace(/^\/+/, '');
			const match = normalizedPath.match(CDN_PATH_REGEX);
			if (!match) return;

			const type = match[1].toLowerCase();      // 'css' | 'js'
			const libraryName = match[2];             // e.g. 'font-awesome', 'jquery'
			const version = match[3];                 // e.g. '4.1', '5.3'
			const fileName = match[4];                // e.g. 'all.min.css'

			const libKey = `${type}:${libraryName.toLowerCase()}`;
			if (!libMap.has(libKey)) {
				libMap.set(libKey, {
					id: libKey,
					type,
					name: libraryName,
					displayName: formatLibraryDisplayName(libraryName),
					versionsMap: new Map()
				});
			}

			const lib = libMap.get(libKey);
			if (!lib.versionsMap.has(version)) {
				lib.versionsMap.set(version, []);
			}

			lib.versionsMap.get(version).push({
				fileName,
				version,
				relativePath: normalizedPath,
				size: item.size || null,
				lastModified: item.lastModified || null
			});
		});

		// Convert Maps to sorted Arrays (newest version first)
		const libraries = Array.from(libMap.values()).map((lib) => {
			const versions = Array.from(lib.versionsMap.entries())
				.map(([version, files]) => ({
					version,
					files: files.sort((a, b) => a.fileName.localeCompare(b.fileName))
				}))
				.sort((a, b) => compareSemverDesc(a.version, b.version));

			return {
				id: lib.id,
				type: lib.type,
				name: lib.name,
				displayName: lib.displayName,
				versions,
				selectedVersion: 'all' // Show all versions by default or allow filtering per card
			};
		});

		// Sort libraries alphabetically by name
		return libraries.sort((a, b) => a.name.localeCompare(b.name));
	}

	function compareSemverDesc(vA, vB) {
		const partsA = String(vA).split(/[.-]/).map((n) => (isNaN(n) ? n : Number(n)));
		const partsB = String(vB).split(/[.-]/).map((n) => (isNaN(n) ? n : Number(n)));
		const len = Math.max(partsA.length, partsB.length);
		for (let i = 0; i < len; i++) {
			const a = partsA[i] ?? 0;
			const b = partsB[i] ?? 0;
			if (a !== b) {
				return b > a ? 1 : -1;
			}
		}
		return 0;
	}

	function formatLibraryDisplayName(slug) {
		const knownNames = {
			'jquery': 'jQuery',
			'jquery-ui': 'jQuery UI',
			'font-awesome': 'Font Awesome',
			'fontawesome': 'Font Awesome',
			'bootstrap': 'Bootstrap',
			'tailwindcss': 'Tailwind CSS',
			'select2': 'Select2',
			'datatables': 'DataTables',
			'chartjs': 'Chart.js',
			'lodash': 'Lodash',
			'moment': 'Moment.js',
			'axios': 'Axios'
		};
		const lower = slug.toLowerCase();
		if (knownNames[lower]) return knownNames[lower];
		return slug
			.split(/[-_]+/)
			.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
			.join(' ');
	}

	/* ==========================================================================
	   Rendering UI
	   ========================================================================== */
	function render() {
		updateCategoryCounts();

		const query = state.searchQuery;
		const filteredLibraries = [];

		state.libraries.forEach((lib) => {
			if (state.activeFilter !== 'all' && lib.type !== state.activeFilter) {
				return;
			}

			// Filter versions and files matching search query
			const matchingVersions = [];
			lib.versions.forEach((verObj) => {
				// Respect the card's version dropdown unless user is actively typing a search query
				if (!query && lib.selectedVersion !== 'all' && verObj.version !== lib.selectedVersion) {
					return;
				}

				const matchingFiles = verObj.files.filter((file) => {
					if (!query) return true;
					const haystack = `${lib.name} ${lib.displayName} ${lib.type} ${verObj.version} ${file.fileName} ${file.relativePath}`.toLowerCase();
					// Support multi-word queries like "jquery 5.3"
					return query.split(/\s+/).every((term) => haystack.includes(term));
				});

				if (matchingFiles.length > 0) {
					matchingVersions.push({
						version: verObj.version,
						files: matchingFiles
					});
				}
			});

			if (matchingVersions.length > 0) {
				filteredLibraries.push({
					...lib,
					matchingVersions
				});
			}
		});

		// Update summary bar
		const totalMatchingFiles = filteredLibraries.reduce(
			(sum, lib) => sum + lib.matchingVersions.reduce((vSum, v) => vSum + v.files.length, 0),
			0
		);
		els.resultsSummaryText.innerHTML = `Showing <strong>${filteredLibraries.length}</strong> ${filteredLibraries.length === 1 ? 'library' : 'libraries'} (<strong>${totalMatchingFiles}</strong> ${totalMatchingFiles === 1 ? 'file' : 'files'})`;

		// Toggle Empty State vs Grid
		if (filteredLibraries.length === 0) {
			els.librariesGrid.innerHTML = '';
			els.emptyState.hidden = false;

			if (state.libraries.length === 0) {
				els.emptyStateTitle.textContent = 'No CDN assets found in Azure container yet';
				els.emptyStateDesc.innerHTML = 'Upload your folders to <code>/css/cdn/{library}/{version}/</code> and <code>/js/cdn/{library}/{version}/</code> in your <strong>global-assets</strong> Azure Blob container, then click <strong>Sync</strong>.';
				els.resetFiltersBtn.hidden = true;
			} else {
				els.emptyStateTitle.textContent = 'No matching assets found';
				els.emptyStateDesc.innerHTML = 'Try adjusting your search query or category filter.';
				els.resetFiltersBtn.hidden = false;
			}
			return;
		}

		els.emptyState.hidden = true;
		els.librariesGrid.innerHTML = filteredLibraries.map(renderLibraryCard).join('');
		bindCardEvents();
	}

	function renderLibraryCard(lib) {
		const isJs = lib.type === 'js';
		const badgeLabel = isJs ? 'JavaScript' : 'Stylesheet';
		const badgeClass = isJs ? 'type-js' : 'type-css';
		const folderPrefix = `/${lib.type}/cdn/${lib.name}/`;

		const versionOptions = [
			`<option value="all" ${lib.selectedVersion === 'all' ? 'selected' : ''}>All Versions (${lib.versions.length})</option>`,
			...lib.versions.map((v, idx) => {
				const latestSuffix = idx === 0 ? ' (Latest)' : '';
				const selected = lib.selectedVersion === v.version ? 'selected' : '';
				return `<option value="${escapeHtml(v.version)}" ${selected}>v${escapeHtml(v.version)}${latestSuffix}</option>`;
			})
		].join('');

		const rowsHtml = lib.matchingVersions
			.map((verObj) => verObj.files.map((file) => renderFileRow(lib, file)).join(''))
			.join('');

		return `
			<article class="library-card" data-lib-id="${escapeHtml(lib.id)}">
				<div class="card-header">
					<div class="card-title-group">
						<span class="category-badge ${badgeClass}">${badgeLabel}</span>
						<h3 class="library-name">${escapeHtml(lib.displayName)}</h3>
						<code class="library-path-chip">${escapeHtml(folderPrefix)}</code>
					</div>
					<div class="version-controls">
						<label class="version-label" for="ver-${escapeHtml(lib.id)}">Version:</label>
						<select id="ver-${escapeHtml(lib.id)}" class="version-select" data-lib-id="${escapeHtml(lib.id)}">
							${versionOptions}
						</select>
					</div>
				</div>
				<div class="file-list">
					${rowsHtml}
				</div>
			</article>
		`;
	}

	function renderFileRow(lib, file) {
		const fullUrl = buildFullAssetUrl(file.relativePath);
		const htmlSnippet = buildHtmlTagSnippet(lib.type, fullUrl);
		const tagButtonLabel = lib.type === 'js' ? 'Copy &lt;script&gt;' : 'Copy &lt;link&gt;';

		const metaParts = [];
		if (file.size) metaParts.push(formatBytes(file.size));
		if (file.lastModified) metaParts.push(`Updated ${formatShortDate(file.lastModified)}`);
		const metaHtml = metaParts.length > 0 ? `<span class="file-meta">&bull; ${escapeHtml(metaParts.join(' • '))}</span>` : '';

		return `
			<div class="file-row">
				<div class="file-info">
					<div class="file-primary">
						<span class="version-tag">v${escapeHtml(file.version)}</span>
						<span class="file-name">${escapeHtml(file.fileName)}</span>
						${metaHtml}
					</div>
					<code class="file-url-preview">${escapeHtml(fullUrl)}</code>
				</div>
				<div class="file-actions">
					<button
						type="button"
						class="btn-copy btn-copy-primary"
						data-copy-text="${escapeHtml(fullUrl)}"
						data-copy-label="CDN URL"
						title="Copy direct CDN URL to clipboard"
					>
						<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
							<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
							<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
						</svg>
						<span>Copy URL</span>
					</button>
					<button
						type="button"
						class="btn-copy"
						data-copy-text="${escapeHtml(htmlSnippet)}"
						data-copy-label="HTML Tag"
						title="Copy HTML snippet to clipboard"
					>
						<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
							<polyline points="16 18 22 12 16 6"></polyline>
							<polyline points="8 6 2 12 8 18"></polyline>
						</svg>
						<span>${tagButtonLabel}</span>
					</button>
					<a
						href="${escapeHtml(fullUrl)}"
						target="_blank"
						rel="noopener"
						class="btn-open-raw"
						title="Open raw file in new tab"
						aria-label="Open ${escapeHtml(file.fileName)} in new tab"
					>
						<svg viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
							<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
							<polyline points="15 3 21 3 21 9"></polyline>
							<line x1="10" y1="14" x2="21" y2="3"></line>
						</svg>
					</a>
				</div>
			</div>
		`;
	}

	function bindCardEvents() {
		// Version Selector Dropdowns
		document.querySelectorAll('.version-select').forEach((select) => {
			select.addEventListener('change', (e) => {
				const libId = e.target.dataset.libId;
				const targetLib = state.libraries.find((l) => l.id === libId);
				if (targetLib) {
					targetLib.selectedVersion = e.target.value;
					render();
				}
			});
		});

		// Copy Buttons
		document.querySelectorAll('.btn-copy').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const textToCopy = btn.dataset.copyText;
				const label = btn.dataset.copyLabel || 'Text';
				await copyToClipboard(textToCopy, btn, label);
			});
		});
	}

	/* ==========================================================================
	   Helper Utilities
	   ========================================================================== */
	function buildFullAssetUrl(relativePath) {
		const base = (state.baseUrl || DEFAULT_AZURE_CONTAINER_URL).replace(/\/+$/, '');
		const cleanRel = relativePath.replace(/^\/+/, '');
		return `${base}/${cleanRel}`;
	}

	function buildHtmlTagSnippet(type, fullUrl) {
		if (type === 'css') {
			return `<link rel="stylesheet" href="${fullUrl}">`;
		}
		return `<script src="${fullUrl}"></script>`;
	}

	async function copyToClipboard(text, buttonEl, label) {
		try {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(text);
			} else {
				const textarea = document.createElement('textarea');
				textarea.value = text;
				textarea.style.position = 'fixed';
				textarea.style.opacity = '0';
				document.body.appendChild(textarea);
				textarea.select();
				document.execCommand('copy');
				document.body.removeChild(textarea);
			}

			// Visual button feedback
			const spanEl = buttonEl.querySelector('span');
			const originalLabel = spanEl ? spanEl.innerHTML : '';
			buttonEl.classList.add('copied');
			if (spanEl) spanEl.textContent = 'Copied!';

			showToast(`Copied ${label} to clipboard`);

			setTimeout(() => {
				buttonEl.classList.remove('copied');
				if (spanEl) spanEl.innerHTML = originalLabel;
			}, 1600);
		} catch (err) {
			console.error('Copy failed:', err);
			showToast('Unable to copy automatically. Please copy manually.');
		}
	}

	function updateCategoryCounts() {
		let jsCount = 0;
		let cssCount = 0;

		state.libraries.forEach((lib) => {
			const fileCount = lib.versions.reduce((sum, v) => sum + v.files.length, 0);
			if (lib.type === 'js') jsCount += fileCount;
			if (lib.type === 'css') cssCount += fileCount;
		});

		els.countAll.textContent = jsCount + cssCount;
		els.countJs.textContent = jsCount;
		els.countCss.textContent = cssCount;
	}

	function countTotalFiles(libraries) {
		return libraries.reduce(
			(sum, lib) => sum + lib.versions.reduce((vSum, v) => vSum + v.files.length, 0),
			0
		);
	}

	function setLoading(isLoading) {
		els.loadingState.hidden = !isLoading;
		if (isLoading) {
			els.librariesGrid.innerHTML = '';
			els.emptyState.hidden = true;
		}
	}

	function updateStatus(mode, text) {
		els.sourceStatusDot.className = 'status-dot';
		if (mode === 'online') els.sourceStatusDot.classList.add('online');
		if (mode === 'local') els.sourceStatusDot.classList.add('local');
		els.sourceStatusText.textContent = text;
	}

	function showToast(message) {
		const toast = document.createElement('div');
		toast.className = 'toast';
		toast.innerHTML = `
			<svg viewBox="0 0 24 24" width="16" height="16" stroke="#F2A900" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
				<polyline points="20 6 9 17 4 12"></polyline>
			</svg>
			<span>${escapeHtml(message)}</span>
		`;
		els.toastContainer.appendChild(toast);
		setTimeout(() => {
			toast.remove();
		}, 2600);
	}

	function formatBytes(bytes) {
		if (!bytes || isNaN(bytes)) return '';
		if (bytes < 1024) return `${bytes} B`;
		const kb = bytes / 1024;
		if (kb < 1024) return `${kb.toFixed(1)} KB`;
		return `${(kb / 1024).toFixed(2)} MB`;
	}

	function formatShortDate(dateStr) {
		const d = new Date(dateStr);
		if (isNaN(d.getTime())) return '';
		return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}

	function escapeHtml(str) {
		return String(str)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	// Boot application
	document.addEventListener('DOMContentLoaded', init);
})();
