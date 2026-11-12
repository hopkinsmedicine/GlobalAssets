/**
 * ============================================================================
 * Johns Hopkins Medicine - Global Assets Portal (/js/site.js)
 * ============================================================================
 *
 * PURPOSE:
 * This file powers the user interface for the Johns Hopkins Medicine Global
 * Assets repository. It dynamically discovers CSS, JavaScript, and Image files
 * hosted in the repository, groups them by library and version, and renders an
 * interactive UI where users can search, filter, and copy CDN links or generate
 * accessible HTML image tags.
 *
 * HOW DYNAMIC ASSET DISCOVERY WORKS (2-Tier Architecture):
 * 1. Tier 1 - Azure Blob Storage Live XML Listing:
 *    Queries Azure's built-in container listing API (?restype=container&comp=list).
 *    Automatically finds any files matching:
 *      - css/cdn/{library}/{version}/{file}
 *      - js/cdn/{library}/{version}/{file}
 *      - img/cdn/{category}/{file} (or img/cdn/{category}/{version}/{file})
 *
 * 2. Tier 2 - Local Dev Server Folder Auto-Crawler:
 *    When running locally on a developer's machine via VS Code Live Server
 *    (localhost / 127.0.0.1), it crawls the HTML directory listings of
 *    /css/cdn/, /js/cdn/, and /img/cdn/ so newly added folders/files appear
 *    immediately on browser refresh without needing to upload to Azure first.
 */

// We wrap the entire script in an IIFE (Immediately Invoked Function Expression)
// `(function() { ... })()` so our variables and functions don't leak into the
// global `window` object or collide with other scripts.
(function () {
	'use strict';

	/**
	 * Default root URL of the Azure Blob Storage container where assets live.
	 * Used when building full CDN links for the "Copy URL" and "Copy <script>" buttons.
	 */
	const DEFAULT_AZURE_CONTAINER_URL = 'https://jhmcdn.blob.core.windows.net/global-assets';

	/**
	 * Regular Expression used to validate and extract metadata from a CSS or JS file path.
	 *
	 * Breakdown of `^\/?(css|js)\/cdn\/([^/]+)\/([^/]+)\/(.+)$`:
	 * - `^\/?`       : Optional leading slash at the start of the path
	 * - `(css|js)`   : Capture Group 1 -> Asset type ('css' or 'js')
	 * - `\/cdn\/`    : Must be inside the `/cdn/` folder (ignores site.css and site.js!)
	 * - `([^/]+)`    : Capture Group 2 -> Library folder name (e.g., 'jquery', 'font-awesome')
	 * - `\/([^/]+)\/`: Capture Group 3 -> Version folder name (e.g., '4.1', '4.7', '5.3')
	 * - `(.+)$`      : Capture Group 4 -> File name (or nested subpath, e.g., 'jquery.min.js')
	 */
	const CDN_CODE_PATH_REGEX = /^\/?(css|js)\/cdn\/([^/]+)\/([^/]+)\/(.+)$/i;

	/**
	 * Regular Expressions used to validate and extract metadata from an Image path inside `/img/cdn/`.
	 *
	 * Supports BOTH patterns:
	 * 1. Direct category folder (no version folder needed, version can be in filename):
	 *    e.g., `img/cdn/logos/jhm-logo.png` -> category: 'logos', file: 'jhm-logo.png'
	 * 2. Versioned subfolder:
	 *    e.g., `img/cdn/logos/1.0/jhm-logo.png` -> category: 'logos', version: '1.0', file: 'jhm-logo.png'
	 */
	const CDN_IMG_VERSIONED_REGEX = /^\/?img\/cdn\/([^/]+)\/([^/]+)\/(.+)$/i;
	const CDN_IMG_DIRECT_REGEX = /^\/?img\/cdn\/([^/]+)\/([^/]+)$/i;
	const CDN_IMG_ROOT_REGEX = /^\/?img\/cdn\/([^/]+)$/i;

	/**
	 * Helper function that parses any relative blob/file path and returns its
	 * structured asset parts (`{ type, libraryName, version, fileName }`),
	 * or `null` if the path is not inside `/css/cdn/`, `/js/cdn/`, or `/img/cdn/`.
	 *
	 * @param {string} rawPath - Relative path to inspect.
	 * @returns {{type: 'css'|'js'|'img', libraryName: string, version: string, fileName: string}|null}
	 */
	function parseCdnAssetPath(rawPath) {
		const normalized = rawPath.replace(/^\/+/, '');

		// 1. Check if it's a CSS or JS library file: {css|js}/cdn/{library}/{version}/{file}
		const codeMatch = normalized.match(CDN_CODE_PATH_REGEX);
		if (codeMatch) {
			return {
				type: codeMatch[1].toLowerCase(),
				libraryName: codeMatch[2],
				version: codeMatch[3],
				fileName: codeMatch[4]
			};
		}

		// 2. Check if it's an Image inside a version subfolder: img/cdn/{category}/{version}/{file}
		const imgVerMatch = normalized.match(CDN_IMG_VERSIONED_REGEX);
		if (imgVerMatch) {
			return {
				type: 'img',
				libraryName: imgVerMatch[1],
				version: imgVerMatch[2],
				fileName: imgVerMatch[3]
			};
		}

		// 3. Check if it's an Image inside a category folder (no version subfolder): img/cdn/{category}/{file}
		const imgDirectMatch = normalized.match(CDN_IMG_DIRECT_REGEX);
		if (imgDirectMatch) {
			return {
				type: 'img',
				libraryName: imgDirectMatch[1],
				version: 'latest',
				fileName: imgDirectMatch[2]
			};
		}

		// 4. Check if it's an Image placed directly inside img/cdn/{file}
		const imgRootMatch = normalized.match(CDN_IMG_ROOT_REGEX);
		if (imgRootMatch) {
			return {
				type: 'img',
				libraryName: 'general-images',
				version: 'latest',
				fileName: imgRootMatch[1]
			};
		}

		return null;
	}

	/**
	 * Central Application State.
	 * Keeping all UI state in one object makes it easy to understand what the UI
	 * is currently showing and re-render cleanly whenever the user types or clicks.
	 */
	const state = {
		libraries: [],          // Array of grouped library objects (created by groupAssetsIntoLibraries)
		activeFilter: 'all',    // Currently selected category tab: 'all' | 'js' | 'css' | 'img'
		searchQuery: '',        // Current lowercase text in the search box
		baseUrl: DEFAULT_AZURE_CONTAINER_URL, // Root CDN URL prepended to relative file paths
		sourceMode: 'auto',     // Discovery mode selected in dropdown: 'auto' | 'azure' | 'local'
		activeSourceLabel: '',  // Human-readable name of the source currently in use

		// Image Tag Generator Modal State
		modal: {
			isOpen: false,
			mode: 'img',        // 'img' (<img> only) | 'figure' (<figure> + <img> + <figcaption>)
			imageUrl: '',
			fileName: '',
			altText: '',
			figcaptionText: '',
			lastFocusedElement: null // Remembers which button opened the modal to restore focus on close
		}
	};

	/**
	 * Cached DOM Element References.
	 * We look up these elements once at startup instead of querying the DOM
	 * repeatedly every time the UI re-renders.
	 */
	const els = {
		searchInput: document.getElementById('searchInput'),
		filterTabs: document.querySelectorAll('.filter-tab'),
		countAll: document.getElementById('countAll'),
		countJs: document.getElementById('countJs'),
		countCss: document.getElementById('countCss'),
		countImg: document.getElementById('countImg'),
		sourceModeSelect: document.getElementById('sourceModeSelect'),
		baseUrlInput: document.getElementById('baseUrlInput'),
		sourceStatusDot: document.getElementById('sourceStatusDot'),
		sourceStatusText: document.getElementById('sourceStatusText'),
		refreshBtn: document.getElementById('refreshBtn'),
		resultsSummaryText: document.getElementById('resultsSummaryText'),
		loadingState: document.getElementById('loadingState'),
		emptyState: document.getElementById('emptyState'),
		emptyStateTitle: document.getElementById('emptyStateTitle'),
		emptyStateDesc: document.getElementById('emptyStateDesc'),
		resetFiltersBtn: document.getElementById('resetFiltersBtn'),
		librariesGrid: document.getElementById('librariesGrid'),
		toastContainer: document.getElementById('toastContainer'),

		// Image Tag Generator Modal DOM Elements
		imgTagModalBackdrop: document.getElementById('imgTagModalBackdrop'),
		imgModalCloseBtn: document.getElementById('imgModalCloseBtn'),
		imgModalCancelBtn: document.getElementById('imgModalCancelBtn'),
		imgModalCopyBtn: document.getElementById('imgModalCopyBtn'),
		imgModalThumb: document.getElementById('imgModalThumb'),
		imgModalFileName: document.getElementById('imgModalFileName'),
		imgModalFileUrl: document.getElementById('imgModalFileUrl'),
		modeImgOnlyBtn: document.getElementById('modeImgOnlyBtn'),
		modeFigureBtn: document.getElementById('modeFigureBtn'),
		imgAltInput: document.getElementById('imgAltInput'),
		figcaptionFieldGroup: document.getElementById('figcaptionFieldGroup'),
		imgFigcaptionInput: document.getElementById('imgFigcaptionInput'),
		imgModalCodePreview: document.getElementById('imgModalCodePreview')
	};

	/* ==========================================================================
	   1. Initialization & Setup Functions
	   ========================================================================== */

	/**
	 * Main entry point called once the HTML document finishes loading.
	 * Detects the base URL, attaches event listeners, and kicks off the
	 * initial asset discovery scan.
	 */
	function init() {
		initBaseUrl();
		bindEvents();
		discoverAssets();
	}

	/**
	 * Automatically detects the root Base URL based on where `index.html` is hosted:
	 *
	 * 1. If hosted on Azure Blob Storage (`*.blob.core.windows.net`):
	 *    Extracts the container name from the URL path (e.g., `https://jhmcdn.blob.core.windows.net/global-assets`).
	 * 2. If running on a local dev server (`localhost` or `127.0.0.1`):
	 *    Uses the local server root URL (e.g., `http://127.0.0.1:5500`) so clicking "Open Raw File"
	 *    or "Copy URL" points directly to the local files during local development.
	 */
	function initBaseUrl() {
		const loc = window.location;
		if (loc.hostname.includes('blob.core.windows.net')) {
			// Split the URL path by '/' and `.filter(Boolean)` removes empty strings
			const parts = loc.pathname.split('/').filter(Boolean);
			if (parts.length > 0) {
				state.baseUrl = `${loc.origin}/${parts[0]}`;
				els.baseUrlInput.value = state.baseUrl;
			}
		} else if (['localhost', '127.0.0.1'].includes(loc.hostname)) {
			state.baseUrl = getLocalBaseUrl();
			els.baseUrlInput.value = state.baseUrl;
		}
	}

	/**
	 * Computes the root directory URL when running on `localhost` / `127.0.0.1`.
	 * For example, if viewing `http://127.0.0.1:5500/index.html`, this returns `http://127.0.0.1:5500`.
	 * If viewing inside a subfolder `http://127.0.0.1:5500/GlobalAssets/index.html`,
	 * it strips `/index.html` and returns `http://127.0.0.1:5500/GlobalAssets`.
	 *
	 * @returns {string} The local base URL without a trailing slash.
	 */
	function getLocalBaseUrl() {
		const loc = window.location;
		const cleanPath = loc.pathname.replace(/\/index\.html$/i, '').replace(/\/+$/, '');
		return `${loc.origin}${cleanPath}`;
	}

	/**
	 * Registers all top-level UI event listeners (search bar, keyboard shortcuts,
	 * category filter tabs, source dropdown, base URL input, sync button, and modal controls).
	 */
	function bindEvents() {
		// 1. Live Search Input: re-renders the grid on every keystroke
		els.searchInput.addEventListener('input', (e) => {
			state.searchQuery = e.target.value.trim().toLowerCase();
			render();
		});

		// 2. Global Keyboard Shortcuts:
		//    - Pressing 'Escape' closes the Image Tag Generator modal if it is open.
		//    - Pressing '/' anywhere (when not typing in an input) focuses the search box.
		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape' && state.modal.isOpen) {
				e.preventDefault();
				closeImageTagModal();
				return;
			}
			const activeTag = document.activeElement ? document.activeElement.tagName : '';
			if (e.key === '/' && !state.modal.isOpen && activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') {
				e.preventDefault(); // Prevents '/' from being typed into the search input itself
				els.searchInput.focus();
			}
		});

		// 3. Category Filter Buttons ('All Assets', 'JavaScript', 'Stylesheets', 'Images')
		els.filterTabs.forEach((tab) => {
			tab.addEventListener('click', () => {
				// First, remove the active highlight and aria-pressed state from all buttons
				els.filterTabs.forEach((t) => {
					t.classList.remove('active');
					t.setAttribute('aria-pressed', 'false');
				});
				// Then highlight the clicked button and update state.activeFilter
				tab.classList.add('active');
				tab.setAttribute('aria-pressed', 'true');
				state.activeFilter = tab.dataset.filter;
				render();
			});
		});

		// 4. Discovery Source Dropdown ('auto', 'azure', 'local')
		els.sourceModeSelect.addEventListener('change', (e) => {
			state.sourceMode = e.target.value;

			// Automatically sync the Base URL input when switching between Azure and Local on localhost
			const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
			if (state.sourceMode === 'azure') {
				state.baseUrl = DEFAULT_AZURE_CONTAINER_URL;
				els.baseUrlInput.value = state.baseUrl;
			} else if (isLocalhost && (state.sourceMode === 'local' || state.sourceMode === 'auto')) {
				state.baseUrl = getLocalBaseUrl();
				els.baseUrlInput.value = state.baseUrl;
			}

			discoverAssets();
		});

		// 5. Base CDN URL Input: strips any trailing slashes (`\/+$`) so we don't
		//    accidentally generate double slashes like `.../global-assets//js/...`
		els.baseUrlInput.addEventListener('input', (e) => {
			state.baseUrl = e.target.value.trim().replace(/\/+$/, '');
			render();
		});

		// 6. Manual Sync / Refresh Button
		els.refreshBtn.addEventListener('click', () => {
			discoverAssets(true);
		});

		// 7. Reset Search & Filters Button (shown in the Empty State when a search has 0 hits)
		els.resetFiltersBtn.addEventListener('click', () => {
			state.searchQuery = '';
			state.activeFilter = 'all';
			els.searchInput.value = '';
			els.filterTabs.forEach((t) => {
				const isAll = t.dataset.filter === 'all';
				t.classList.toggle('active', isAll);
				t.setAttribute('aria-pressed', isAll ? 'true' : 'false');
			});
			render();
			els.searchInput.focus();
		});

		// 8. Image Tag Generator Modal Events
		bindModalEvents();
	}

	/**
	 * Attaches event listeners for the "Generate Tag" Image Modal:
	 * - Switching between `<img>` only and `<figure>` + `<figcaption>` mode
	 * - Live real-time updating of the HTML tag preview as the user types in the `alt` and `figcaption` inputs
	 * - Copying the generated HTML snippet to the clipboard
	 * - Closing the modal via the Close (X) button, Cancel button, or clicking the backdrop overlay
	 */
	function bindModalEvents() {
		if (!els.imgTagModalBackdrop) return;

		// Toggle Button 1: <img> tag only
		els.modeImgOnlyBtn.addEventListener('click', () => {
			setModalTagMode('img');
		});

		// Toggle Button 2: <img> with <figure> & <figcaption>
		els.modeFigureBtn.addEventListener('click', () => {
			setModalTagMode('figure');
		});

		// Live real-time update when typing in the Alt Text field
		els.imgAltInput.addEventListener('input', (e) => {
			state.modal.altText = e.target.value;
			updateModalLivePreview();
		});

		// Live real-time update when typing in the Figcaption field
		els.imgFigcaptionInput.addEventListener('input', (e) => {
			state.modal.figcaptionText = e.target.value;
			updateModalLivePreview();
		});

		// Copy Generated Tag button inside the modal footer
		els.imgModalCopyBtn.addEventListener('click', async () => {
			const generatedHtml = buildModalImageHtmlSnippet();
			const label = state.modal.mode === 'figure' ? '<figure> HTML tag' : '<img> HTML tag';
			await copyToClipboard(generatedHtml, els.imgModalCopyBtn, label);
		});

		// Close buttons (X icon and Cancel button)
		els.imgModalCloseBtn.addEventListener('click', closeImageTagModal);
		els.imgModalCancelBtn.addEventListener('click', closeImageTagModal);

		// Clicking outside the modal dialog box (on the dark backdrop) closes the modal
		els.imgTagModalBackdrop.addEventListener('click', (e) => {
			if (e.target === els.imgTagModalBackdrop) {
				closeImageTagModal();
			}
		});
	}

	/* ==========================================================================
	   2. Dynamic Asset Discovery Engine (Azure Live XML + Local Folder Crawler)
	   ========================================================================== */

	/**
	 * Orchestrates asset discovery across our 2 tiers (Azure Blob Live XML and
	 * Local Dev Server Crawler) based on the current environment and the user's
	 * selected `state.sourceMode`.
	 *
	 * @param {boolean} [isManualRefresh=false] - True if triggered by clicking the "Sync" button
	 *                                            (shows a toast notification when finished).
	 */
	async function discoverAssets(isManualRefresh = false) {
		setLoading(true);
		updateStatus('connecting', 'Scanning repository...');

		// Check if the developer is running on a local web server (e.g., VS Code Live Server)
		const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);

		let items = [];
		let sourceUsed = '';

		try {
			if (state.sourceMode === 'azure') {
				// User explicitly selected "Azure Blob Live XML" in the dropdown
				items = await fetchFromAzureBlobXml(state.baseUrl);
				sourceUsed = 'Azure Blob Live';
			} else if (state.sourceMode === 'local') {
				// User explicitly selected "Local /cdn/ Folders" in the dropdown
				items = await crawlLocalCdnDirectories();
				sourceUsed = 'Local /cdn/ Folders';
			} else {
				// Default 'auto' mode (Smart Detect):
				// TIER 2 (Local Dev): If running on localhost, crawl local `/css/cdn/`, `/js/cdn/`, and `/img/cdn/` first.
				// This lets developers add a folder locally and see it immediately on refresh!
				if (isLocalhost) {
					items = await crawlLocalCdnDirectories();
					if (items.length > 0) {
						sourceUsed = 'Local Dev Server (/cdn/)';
					}
				}

				// TIER 1 (Azure Production): If not on localhost (or local crawl returned nothing),
				// query Azure Blob Live XML.
				// Note: Always use the Azure container URL (not a localhost URL) when querying Azure XML!
				if (items.length === 0) {
					const azureContainerUrl = isLocalhost ? DEFAULT_AZURE_CONTAINER_URL : state.baseUrl;
					const azureItems = await fetchFromAzureBlobXml(azureContainerUrl);
					if (azureItems.length > 0) {
						items = azureItems;
						sourceUsed = 'Azure Blob Live';
						// If we fell back to Azure Live while on localhost, update baseUrl to Azure so links work
						if (isLocalhost) {
							state.baseUrl = azureContainerUrl;
							els.baseUrlInput.value = state.baseUrl;
						}
					} else {
						sourceUsed = 'Azure Blob Live (0 CDN files found)';
					}
				}
			}
		} catch (err) {
			console.warn('Discovery warning:', err);
			sourceUsed = 'Connection Error';
		}

		// Transform the flat array of file paths into structured library -> version -> files objects
		state.libraries = groupAssetsIntoLibraries(items);
		state.activeSourceLabel = sourceUsed;

		// Update the top header status indicator pill and render the cards
		const isAzure = sourceUsed.includes('Azure');
		updateStatus(isAzure ? 'online' : 'local', sourceUsed);
		setLoading(false);
		render();

		if (isManualRefresh) {
			showToast(`Synced ${countTotalFiles(state.libraries)} asset files from ${sourceUsed}`);
		}
	}

	/**
	 * TIER 1 DISCOVERY: Fetches and parses the live XML blob list from Azure Blob Storage.
	 *
	 * How Azure Container Listing works:
	 * When a container's public access level is set to "Container", calling
	 * `https://<account>.blob.core.windows.net/<container>?restype=container&comp=list`
	 * returns an XML document listing up to 5,000 blobs at a time.
	 *
	 * @param {string} containerBaseUrl - The root URL of the Azure Blob container.
	 * @returns {Promise<Array<{path: string, size: number|null, lastModified: string|null}>>}
	 */
	async function fetchFromAzureBlobXml(containerBaseUrl) {
		const cleanBase = (containerBaseUrl || DEFAULT_AZURE_CONTAINER_URL).replace(/\/+$/, '');
		const discovered = [];
		let marker = '';

		// We use a `do ... while (marker)` loop to handle Azure pagination.
		// If the container ever holds more than 5,000 files, Azure provides a `<NextMarker>`
		// token which we pass back in the next request until `<NextMarker>` is empty.
		do {
			// `_t=${Date.now()}` is a cache-buster query param so the browser always fetches fresh XML
			const listUrl = `${cleanBase}?restype=container&comp=list${marker ? `&marker=${encodeURIComponent(marker)}` : ''}&_t=${Date.now()}`;
			const response = await fetch(listUrl, { method: 'GET' });
			if (!response.ok) {
				throw new Error(`Azure list returned HTTP ${response.status}`);
			}

			const xmlText = await response.text();

			// IMPORTANT: Azure Blob Storage responses often include a hidden UTF-8 Byte Order Mark
			// (BOM character `\uFEFF`) at the very beginning of the response. We strip it before
			// passing the string to `DOMParser`, otherwise some browsers fail to parse the XML.
			const cleanXml = xmlText.replace(/^\uFEFF/, '').trim();
			const parser = new DOMParser();
			const xmlDoc = parser.parseFromString(cleanXml, 'application/xml');

			// Loop over every `<Blob>` element in the XML response
			const blobNodes = xmlDoc.querySelectorAll('Blobs > Blob');
			blobNodes.forEach((blobNode) => {
				const nameNode = blobNode.querySelector('Name');
				if (!nameNode) return;

				const blobPath = nameNode.textContent.trim();

				// Only keep files that match `/css/cdn/...`, `/js/cdn/...`, or `/img/cdn/...`.
				// This automatically ignores `index.html`, `css/site.css`, `js/site.js`, `img/logo.png`, etc.
				if (parseCdnAssetPath(blobPath)) {
					const lengthNode = blobNode.querySelector('Properties > Content-Length');
					const modNode = blobNode.querySelector('Properties > Last-Modified');
					discovered.push({
						path: blobPath.replace(/^\/+/, ''),
						size: lengthNode ? parseInt(lengthNode.textContent, 10) : null,
						lastModified: modNode ? modNode.textContent : null
					});
				}
			});

			// Check if Azure returned a pagination marker for the next page of results
			const nextMarkerNode = xmlDoc.querySelector('NextMarker');
			marker = nextMarkerNode && nextMarkerNode.textContent ? nextMarkerNode.textContent.trim() : '';
		} while (marker);

		return discovered;
	}

	/**
	 * TIER 2 DISCOVERY: Crawls local `/css/cdn/`, `/js/cdn/`, and `/img/cdn/` folders when
	 * running on a local development server (such as VS Code Live Server).
	 *
	 * @returns {Promise<Array<{path: string, size: number|null, lastModified: string|null}>>}
	 */
	async function crawlLocalCdnDirectories() {
		const roots = ['css/cdn/', 'js/cdn/', 'img/cdn/'];
		const discovered = [];

		for (const root of roots) {
			try {
				const files = await crawlDirectoryRecursive(root, 0);
				discovered.push(...files);
			} catch (_) {
				// Ignore errors if a folder doesn't exist yet or directory browsing is disabled
			}
		}

		return discovered;
	}

	/**
	 * Recursively walks a local directory listing HTML page returned by a dev server
	 * (like VS Code Live Server) to find all nested asset files.
	 *
	 * @param {string} dirPath - Relative directory path to scan (e.g., 'js/cdn/jquery/').
	 * @param {number} depth   - Current recursion depth (capped at 4 to prevent infinite loops).
	 * @returns {Promise<Array<{path: string, size: null, lastModified: null}>>}
	 */
	async function crawlDirectoryRecursive(dirPath, depth) {
		// Safety guard: never recurse deeper than 4 levels (type -> cdn -> library -> version -> file)
		if (depth > 4) return [];

		const res = await fetch(dirPath);
		if (!res.ok) return [];

		// Verify the server actually returned an HTML directory listing page
		const contentType = res.headers.get('content-type') || '';
		if (!contentType.includes('text/html')) return [];

		const html = await res.text();
		const parser = new DOMParser();
		const doc = parser.parseFromString(html, 'text/html');
		const links = Array.from(doc.querySelectorAll('a[href]'));

		const results = [];
		for (const a of links) {
			const rawHref = a.getAttribute('href');

			// Skip empty links, parent directory links ('../'), current directory ('./'),
			// or sorting query links ('?C=N;O=D') generated by some web servers.
			if (!rawHref || rawHref === '../' || rawHref === './' || rawHref.startsWith('?') || rawHref.startsWith('#')) {
				continue;
			}

			// Convert the link's `href` (which may be relative or root-relative) into a clean
			// full URL using the browser's native `URL` constructor, then extract its pathname.
			const resolvedUrl = new URL(rawHref, new URL(dirPath, window.location.origin + window.location.pathname));
			let relPath = resolvedUrl.pathname.replace(/^\/+/, '');

			// If the developer opened a parent folder in VS Code (so the URL is e.g.
			// `/GlobalAssets/js/cdn/jquery`), strip the leading `/GlobalAssets/` prefix
			// so `relPath` always starts cleanly with `css/cdn/`, `js/cdn/`, or `img/cdn/`.
			const matchIdx = relPath.search(/(css|js|img)\/cdn\//i);
			if (matchIdx > 0) {
				relPath = relPath.slice(matchIdx);
			}

			// Crucial safety check: ignore any link that points *outside* or *above* the
			// directory we are currently scanning (such as a "Parent Directory" link).
			if (!relPath.startsWith(dirPath.replace(/^\/+/, ''))) {
				continue;
			}

			// Determine whether this link is a SUBFOLDER or a FILE:
			// Version folders like "4.7" or "5.3.1" contain dots, so we only treat the
			// last segment as a file if it ends with a known web asset extension.
			const lastSegment = relPath.replace(/\/+$/, '').split('/').pop() || '';
			const isKnownAssetFile = /\.(js|mjs|cjs|css|map|woff2?|ttf|eot|svg|otf|json|png|jpg|jpeg|gif|webp|ico|avif)$/i.test(lastSegment);

			if (rawHref.endsWith('/') || !isKnownAssetFile) {
				// It's a folder (e.g., 'jquery', 'logos', or '4.7') -> recurse inside it!
				const subDir = relPath.endsWith('/') ? relPath : `${relPath}/`;
				const subFiles = await crawlDirectoryRecursive(subDir, depth + 1);
				results.push(...subFiles);
			} else if (parseCdnAssetPath(relPath)) {
				// It's a valid asset file inside `/css/cdn/...`, `/js/cdn/...`, or `/img/cdn/...` -> record it!
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
	   3. Grouping & Sorting Logic
	   ========================================================================== */

	/**
	 * Converts a flat array of discovered file objects into a structured, hierarchical
	 * list of libraries and versions ready for the UI to render.
	 *
	 * @param {Array<{path: string, size?: number|null, lastModified?: string|null}>} items
	 * @returns {Array<Object>} Sorted array of library objects.
	 */
	function groupAssetsIntoLibraries(items) {
		// We use a JavaScript `Map` keyed by `type:libraryName` (e.g., `js:jquery` or `img:logos`)
		const libMap = new Map();

		items.forEach((item) => {
			const normalizedPath = item.path.replace(/^\/+/, '');
			const parsed = parseCdnAssetPath(normalizedPath);
			if (!parsed) return;

			const { type, libraryName, version, fileName } = parsed;
			const libKey = `${type}:${libraryName.toLowerCase()}`;

			// If this is the first time we've seen this library, initialize its entry in `libMap`
			if (!libMap.has(libKey)) {
				libMap.set(libKey, {
					id: libKey,
					type,
					name: libraryName,
					displayName: formatLibraryDisplayName(libraryName),
					versionsMap: new Map() // Inner Map grouping files by version string
				});
			}

			const lib = libMap.get(libKey);

			// If this is the first file we've seen for this specific version, create an empty array
			if (!lib.versionsMap.has(version)) {
				lib.versionsMap.set(version, []);
			}

			// Add the file details into that version's array
			lib.versionsMap.get(version).push({
				fileName,
				version,
				relativePath: normalizedPath,
				size: item.size || null,
				lastModified: item.lastModified || null
			});
		});

		// Convert our nested Maps into clean, sorted Arrays for rendering
		const libraries = Array.from(libMap.values()).map((lib) => {
			const versions = Array.from(lib.versionsMap.entries())
				.map(([version, files]) => ({
					version,
					// Sort files alphabetically within each version (e.g. a.js before b.js)
					files: files.sort((a, b) => a.fileName.localeCompare(b.fileName))
				}))
				// Sort versions from newest to oldest (e.g. 5.3 -> 4.7 -> 4.1)
				.sort((a, b) => compareSemverDesc(a.version, b.version));

			return {
				id: lib.id,
				type: lib.type,
				name: lib.name,
				displayName: lib.displayName,
				versions,
				selectedVersion: 'all' // Default the card's dropdown to show "All Versions"
			};
		});

		// Finally, sort the library cards alphabetically by library name
		return libraries.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Compares two version strings (like "4.1", "4.10", "5.3.1") in DESCENDING order
	 * (newest version first).
	 *
	 * @param {string} vA - First version string.
	 * @param {string} vB - Second version string.
	 * @returns {number} Positive if vB > vA, negative if vA > vB, 0 if equal.
	 */
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

	/**
	 * Converts a folder slug (e.g. `'font-awesome'` or `'jquery'`) into a nicely
	 * capitalized title for the UI card header (e.g. `'Font Awesome'` or `'jQuery'`).
	 *
	 * @param {string} slug - Folder name from `/cdn/{slug}/`.
	 * @returns {string} Human-friendly library title.
	 */
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
	   4. UI Rendering Functions
	   ========================================================================== */

	/**
	 * Main render function.
	 * Reads the current `state` (active category tab, search query, selected versions),
	 * filters `state.libraries` accordingly, updates the counters, and injects the
	 * generated HTML cards into the page.
	 */
	function render() {
		updateCategoryCounts();

		const query = state.searchQuery;
		const filteredLibraries = [];

		// Loop through every library and keep only the ones that match the active filter & search query
		state.libraries.forEach((lib) => {
			// 1. Check Category Tab filter ('all', 'js', 'css', or 'img')
			if (state.activeFilter !== 'all' && lib.type !== state.activeFilter) {
				return;
			}

			// 2. Check Versions and Files inside this library
			const matchingVersions = [];
			lib.versions.forEach((verObj) => {
				// If the user picked a specific version in this card's dropdown (e.g. "v4.7")
				// AND isn't typing a global search query, hide other versions on this card.
				if (!query && lib.selectedVersion !== 'all' && verObj.version !== lib.selectedVersion) {
					return;
				}

				// Filter files inside this version by the user's search query
				const matchingFiles = verObj.files.filter((file) => {
					if (!query) return true;

					// Combine all searchable text for this file into a single lowercase string ("haystack")
					const haystack = `${lib.name} ${lib.displayName} ${lib.type} ${verObj.version} ${file.fileName} ${file.relativePath}`.toLowerCase();

					// Split the user's search query by spaces so multi-word searches like "jquery 4.7"
					// require EVERY word ("jquery" AND "4.7") to appear somewhere in the haystack.
					return query.split(/\s+/).every((term) => haystack.includes(term));
				});

				if (matchingFiles.length > 0) {
					matchingVersions.push({
						version: verObj.version,
						files: matchingFiles
					});
				}
			});

			// If this library has at least one matching file, include it in the rendered results
			if (matchingVersions.length > 0) {
				filteredLibraries.push({
					...lib,
					matchingVersions
				});
			}
		});

		// Count total visible files across all filtered libraries for the summary bar
		const totalMatchingFiles = filteredLibraries.reduce(
			(sum, lib) => sum + lib.matchingVersions.reduce((vSum, v) => vSum + v.files.length, 0),
			0
		);
		els.resultsSummaryText.innerHTML = `Showing <strong>${filteredLibraries.length}</strong> ${filteredLibraries.length === 1 ? 'library' : 'libraries'} (<strong>${totalMatchingFiles}</strong> ${totalMatchingFiles === 1 ? 'file' : 'files'})`;

		// If nothing matched, show the Empty State panel instead of the cards grid
		if (filteredLibraries.length === 0) {
			els.librariesGrid.innerHTML = '';
			els.emptyState.hidden = false;

			if (state.libraries.length === 0) {
				if (window.location.protocol === 'file:' && state.sourceMode === 'local') {
					els.emptyStateTitle.textContent = 'Local folder scanning requires VS Code Live Server';
					els.emptyStateDesc.innerHTML = 'Browsers block local folder discovery over the <code>file://</code> protocol. Please open this project using the VS Code <strong>Live Server</strong> extension (<code>http://127.0.0.1:5500</code>) to scan local <code>/cdn/</code> folders.';
				} else {
					els.emptyStateTitle.textContent = 'No CDN assets found in repository yet';
					els.emptyStateDesc.innerHTML = 'Upload your folders to <code>/css/cdn/</code>, <code>/js/cdn/</code>, or <code>/img/cdn/</code> in your <strong>global-assets</strong> Azure Blob container (or run via VS Code <strong>Live Server</strong> locally), then click <strong>Sync</strong>.';
				}
				els.resetFiltersBtn.hidden = true;
			} else {
				els.emptyStateTitle.textContent = 'No matching assets found';
				els.emptyStateDesc.innerHTML = 'Try adjusting your search query or category filter.';
				els.resetFiltersBtn.hidden = false;
			}
			return;
		}

		// Render all matching library cards into the grid and attach their button listeners
		els.emptyState.hidden = true;
		els.librariesGrid.innerHTML = filteredLibraries.map(renderLibraryCard).join('');
		bindCardEvents();
	}

	/**
	 * Generates the HTML string for a single Library Card (header + version selector + file rows).
	 *
	 * @param {Object} lib - Filtered library object from `render()`.
	 * @returns {string} HTML markup for the `<article class="library-card">`.
	 */
	function renderLibraryCard(lib) {
		let badgeLabel = 'Stylesheet';
		let badgeClass = 'type-css';
		if (lib.type === 'js') {
			badgeLabel = 'JavaScript';
			badgeClass = 'type-js';
		} else if (lib.type === 'img') {
			badgeLabel = 'Image';
			badgeClass = 'type-img';
		}

		const folderPrefix = lib.name === 'general-images' ? `/img/cdn/` : `/${lib.type}/cdn/${lib.name}/`;
		const safeDomId = lib.id.replace(/[^a-zA-Z0-9_-]/g, '-');

		// Hide the Version selector dropdown if this is a flat image folder (only 'latest' version)
		const hasRealVersions = !(lib.type === 'img' && lib.versions.length === 1 && lib.versions[0].version === 'latest');

		let versionControlsHtml = '';
		if (hasRealVersions) {
			const versionOptions = [
				`<option value="all" ${lib.selectedVersion === 'all' ? 'selected' : ''}>All Versions (${lib.versions.length})</option>`,
				...lib.versions.map((v, idx) => {
					const latestSuffix = idx === 0 ? ' (Latest)' : '';
					const selected = lib.selectedVersion === v.version ? 'selected' : '';
					const labelPrefix = v.version === 'latest' ? '' : 'v';
					return `<option value="${escapeHtml(v.version)}" ${selected}>${labelPrefix}${escapeHtml(v.version)}${latestSuffix}</option>`;
				})
			].join('');

			versionControlsHtml = `
				<div class="version-controls">
					<label class="version-label" for="ver-${escapeHtml(safeDomId)}">Version:</label>
					<select
						id="ver-${escapeHtml(safeDomId)}"
						class="version-select"
						data-lib-id="${escapeHtml(lib.id)}"
						aria-label="Filter ${escapeHtml(lib.displayName)} (${badgeLabel}) by version"
					>
						${versionOptions}
					</select>
				</div>
			`;
		}

		// Render each file row inside the card
		const rowsHtml = lib.matchingVersions
			.map((verObj) => verObj.files.map((file) => renderFileRow(lib, file)).join(''))
			.join('');

		return `
			<article class="library-card" data-lib-id="${escapeHtml(lib.id)}" aria-labelledby="title-${escapeHtml(safeDomId)}">
				<div class="card-header">
					<div class="card-title-group">
						<span class="category-badge ${badgeClass}">${badgeLabel}</span>
						<h3 class="library-name" id="title-${escapeHtml(safeDomId)}">${escapeHtml(lib.displayName)}</h3>
						<code class="library-path-chip">${escapeHtml(folderPrefix)}</code>
					</div>
					${versionControlsHtml}
				</div>
				<div class="file-list" role="list" aria-label="${escapeHtml(lib.displayName)} files">
					${rowsHtml}
				</div>
			</article>
		`;
	}

	/**
	 * Generates the HTML string for an individual file row inside a Library Card.
	 * - For JS and CSS files: renders "Copy URL" and "Copy <script>/<link>" buttons.
	 * - For Image files ('img'): renders a live thumbnail preview, "Copy URL", and
	 *   a "Generate Tag" button that opens the interactive Image Tag Generator Modal.
	 *
	 * @param {Object} lib  - The parent library object ('js', 'css', or 'img').
	 * @param {Object} file - The file metadata object (`fileName`, `version`, `relativePath`, etc.).
	 * @returns {string} HTML markup for `<div class="file-row">`.
	 */
	function renderFileRow(lib, file) {
		const fullUrl = buildFullAssetUrl(file.relativePath);
		const isImg = lib.type === 'img';

		// Optional metadata (file size in KB/MB and last modified date when loaded from Azure XML)
		const metaParts = [];
		if (file.size) metaParts.push(formatBytes(file.size));
		if (file.lastModified) metaParts.push(`Updated ${formatShortDate(file.lastModified)}`);
		const metaHtml = metaParts.length > 0 ? `<span class="file-meta">&bull; ${escapeHtml(metaParts.join(' • '))}</span>` : '';

		const versionBadgeHtml = file.version === 'latest'
			? ''
			: `<span class="version-tag">v${escapeHtml(file.version)}</span>`;

		const contextDesc = file.version === 'latest'
			? `${lib.displayName} (${file.fileName})`
			: `${lib.displayName} v${file.version} (${file.fileName})`;

		// Left side of the row: include a thumbnail box if this is an image asset
		const fileInfoSectionHtml = isImg
			? `
				<div class="file-info-with-thumb">
					<div class="file-thumb-box" aria-hidden="true">
						<img src="${escapeHtml(fullUrl)}" alt="" class="file-thumb-img" loading="lazy">
					</div>
					<div class="file-info">
						<div class="file-primary">
							${versionBadgeHtml}
							<span class="file-name">${escapeHtml(file.fileName)}</span>
							${metaHtml}
						</div>
						<code class="file-url-preview">${escapeHtml(fullUrl)}</code>
					</div>
				</div>
			`
			: `
				<div class="file-info">
					<div class="file-primary">
						${versionBadgeHtml}
						<span class="file-name">${escapeHtml(file.fileName)}</span>
						${metaHtml}
					</div>
					<code class="file-url-preview">${escapeHtml(fullUrl)}</code>
				</div>
			`;

		// Second action button: "Generate Tag" modal trigger for images, or direct "Copy <script>/<link>" for JS/CSS
		let secondaryActionButtonHtml = '';
		if (isImg) {
			secondaryActionButtonHtml = `
				<button
					type="button"
					class="btn-generate-tag"
					data-img-url="${escapeHtml(fullUrl)}"
					data-img-filename="${escapeHtml(file.fileName)}"
					aria-label="Generate HTML tag for ${escapeHtml(contextDesc)}"
					title="Open modal to generate <img> or <figure> HTML tag"
				>
					<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
						<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
						<circle cx="8.5" cy="8.5" r="1.5"></circle>
						<polyline points="21 15 16 10 5 21"></polyline>
					</svg>
					<span>Generate Tag</span>
				</button>
			`;
		} else {
			const htmlSnippet = buildHtmlTagSnippet(lib.type, fullUrl);
			const tagButtonLabel = lib.type === 'js' ? 'Copy &lt;script&gt;' : 'Copy &lt;link&gt;';
			const tagKind = lib.type === 'js' ? 'script tag' : 'stylesheet link tag';
			secondaryActionButtonHtml = `
				<button
					type="button"
					class="btn-copy"
					data-copy-text="${escapeHtml(htmlSnippet)}"
					data-copy-label="HTML ${escapeHtml(tagKind)} for ${escapeHtml(contextDesc)}"
					aria-label="Copy HTML ${escapeHtml(tagKind)} for ${escapeHtml(contextDesc)}"
					title="Copy HTML snippet to clipboard"
				>
					<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
						<polyline points="16 18 22 12 16 6"></polyline>
						<polyline points="8 6 2 12 8 18"></polyline>
					</svg>
					<span>${tagButtonLabel}</span>
				</button>
			`;
		}

		return `
			<div class="file-row" role="listitem">
				${fileInfoSectionHtml}
				<div class="file-actions">
					<button
						type="button"
						class="btn-copy btn-copy-primary"
						data-copy-text="${escapeHtml(fullUrl)}"
						data-copy-label="CDN URL for ${escapeHtml(contextDesc)}"
						aria-label="Copy CDN URL for ${escapeHtml(contextDesc)}"
						title="Copy direct CDN URL to clipboard"
					>
						<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
							<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
							<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
						</svg>
						<span>Copy URL</span>
					</button>
					${secondaryActionButtonHtml}
					<a
						href="${escapeHtml(fullUrl)}"
						target="_blank"
						rel="noopener"
						class="btn-open-raw"
						title="Open raw file in new tab"
						aria-label="Open raw file ${escapeHtml(contextDesc)} in a new tab"
					>
						<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">
							<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
							<polyline points="15 3 21 3 21 9"></polyline>
							<line x1="10" y1="14" x2="21" y2="3"></line>
						</svg>
					</a>
				</div>
			</div>
		`;
	}

	/**
	 * Attaches event listeners to dynamically rendered elements inside the Library Cards
	 * (per-card Version `<select>` dropdowns, Copy buttons, and "Generate Tag" image buttons).
	 * Must be called at the end of `render()` whenever `librariesGrid.innerHTML` is updated.
	 */
	function bindCardEvents() {
		// 1. Per-card Version Selector Dropdowns
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

		// 2. Copy Action Buttons ("Copy URL" and "Copy <script>/<link>")
		document.querySelectorAll('.fields-copy, .file-actions .btn-copy').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const textToCopy = btn.dataset.copyText;
				const label = btn.dataset.copyLabel || 'Text';
				await copyToClipboard(textToCopy, btn, label);
			});
		});

		// 3. "Generate Tag" Buttons on Image Rows -> Opens the Image Tag Generator Modal
		document.querySelectorAll('.btn-generate-tag').forEach((btn) => {
			btn.addEventListener('click', () => {
				const imageUrl = btn.dataset.imgUrl;
				const fileName = btn.dataset.imgFilename;
				openImageTagModal(imageUrl, fileName, btn);
			});
		});
	}

	/* ==========================================================================
	   5. Image Tag Generator Modal Functions
	   ========================================================================== */

	/**
	 * Opens the "Generate HTML Image Tag" modal for a clicked image row,
	 * resets the input fields, updates the live code preview, and focuses the Alt input.
	 *
	 * @param {string} imageUrl          - Full CDN URL to the selected image.
	 * @param {string} fileName          - File name of the selected image (e.g., 'jhm-logo.png').
	 * @param {HTMLElement} triggerBtnEl - The "Generate Tag" button that was clicked (so focus returns to it on close).
	 */
	function openImageTagModal(imageUrl, fileName, triggerBtnEl) {
		state.modal.isOpen = true;
		state.modal.imageUrl = imageUrl;
		state.modal.fileName = fileName;
		state.modal.altText = '';
		state.modal.figcaptionText = '';
		state.modal.lastFocusedElement = triggerBtnEl || null;

		// Populate modal preview header
		els.imgModalThumb.src = imageUrl;
		els.imgModalFileName.textContent = fileName;
		els.imgModalFileUrl.textContent = imageUrl;

		// Reset inputs and default to 'img' mode
		els.imgAltInput.value = '';
		els.imgFigcaptionInput.value = '';
		setModalTagMode('img');

		// Show modal and move keyboard focus to the Alt Text input field
		els.imgTagModalBackdrop.hidden = false;
		setTimeout(() => {
			els.imgAltInput.focus();
		}, 20);
	}

	/**
	 * Closes the Image Tag Generator Modal and restores keyboard focus to the
	 * "Generate Tag" button that originally opened it.
	 */
	function closeImageTagModal() {
		state.modal.isOpen = false;
		els.imgTagModalBackdrop.hidden = true;
		if (state.modal.lastFocusedElement) {
			state.modal.lastFocusedElement.focus();
		}
	}

	/**
	 * Switches the modal between `'img'` mode (`<img>` tag only) and `'figure'` mode
	 * (`<figure>` + `<img>` + `<figcaption>`), showing or hiding the second input field
	 * for the `<figcaption>` text accordingly.
	 *
	 * @param {'img'|'figure'} mode - Selected tag generation mode.
	 */
	function setModalTagMode(mode) {
		state.modal.mode = mode;
		const isFigure = mode === 'figure';

		els.modeImgOnlyBtn.classList.toggle('active', !isFigure);
		els.modeImgOnlyBtn.setAttribute('aria-pressed', !isFigure ? 'true' : 'false');

		els.modeFigureBtn.classList.toggle('active', isFigure);
		els.modeFigureBtn.setAttribute('aria-pressed', isFigure ? 'true' : 'false');

		// Show the Caption Text (<figcaption>) field only when 'figure' mode is selected
		els.figcaptionFieldGroup.hidden = !isFigure;

		updateModalLivePreview();
	}

	/**
	 * Builds the exact HTML string (`<img>` or `<figure>...</figure>`) based on
	 * the current modal state (`imageUrl`, `altText`, `figcaptionText`, and `mode`).
	 *
	 * @returns {string} Generated HTML tag snippet.
	 */
	function buildModalImageHtmlSnippet() {
		const safeUrl = escapeHtml(state.modal.imageUrl);
		const safeAlt = escapeHtml(state.modal.altText);

		if (state.modal.mode === 'figure') {
			const safeCaption = escapeHtml(state.modal.figcaptionText);
			return `<figure>\n  <img src="${safeUrl}" alt="${safeAlt}">\n  <figcaption>${safeCaption}</figcaption>\n</figure>`;
		}

		return `<img src="${safeUrl}" alt="${safeAlt}">`;
	}

	/**
	 * Updates the `<code id="imgModalCodePreview">` box in real time whenever the
	 * user types in the Alt Text or Figcaption input fields or switches the mode toggle.
	 */
	function updateModalLivePreview() {
		els.imgModalCodePreview.textContent = buildModalImageHtmlSnippet();
	}

	/* ==========================================================================
	   6. Helper & Utility Functions
	   ========================================================================== */

	/**
	 * Combines the configured Base CDN URL (`state.baseUrl`) with a file's relative path
	 * to produce a complete URL.
	 *
	 * @param {string} relativePath - Path starting with `css/cdn/...`, `js/cdn/...`, or `img/cdn/...`.
	 * @returns {string} Complete URL to the asset.
	 */
	function buildFullAssetUrl(relativePath) {
		const base = (state.baseUrl || DEFAULT_AZURE_CONTAINER_URL).replace(/\/+$/, '');
		const cleanRel = relativePath.replace(/^\/+/, '');
		return `${base}/${cleanRel}`;
	}

	/**
	 * Builds a ready-to-paste HTML `<link>` or `<script>` tag for a given CSS or JS URL.
	 *
	 * @param {'css'|'js'} type - Asset category type.
	 * @param {string} fullUrl  - Complete URL to the asset.
	 * @returns {string} HTML tag snippet.
	 */
	function buildHtmlTagSnippet(type, fullUrl) {
		if (type === 'css') {
			return `<link rel="stylesheet" href="${fullUrl}">`;
		}
		return `<script src="${fullUrl}"></script>`;
	}

	/**
	 * Copies a string of text to the user's system clipboard, temporarily changes
	 * the clicked button's text to "Copied!" (with a green highlight), and displays
	 * a toast notification in the bottom-right corner.
	 *
	 * @param {string} text            - The exact string to copy to the clipboard.
	 * @param {HTMLElement} buttonEl   - The button element that was clicked.
	 * @param {string} label           - Short description of what was copied (e.g. 'CDN URL').
	 */
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

			// Temporarily change button appearance to green "Copied!" state
			const spanEl = buttonEl.querySelector('span');
			const originalLabel = spanEl ? spanEl.innerHTML : '';
			buttonEl.classList.add('copied');
			if (spanEl) spanEl.textContent = 'Copied!';

			showToast(`Copied ${label} to clipboard`);

			// Restore the original button label after 1.6 seconds
			setTimeout(() => {
				buttonEl.classList.remove('copied');
				if (spanEl) spanEl.innerHTML = originalLabel;
			}, 1600);
		} catch (err) {
			console.error('Copy failed:', err);
			showToast('Unable to copy automatically. Please copy manually.');
		}
	}

	/**
	 * Calculates the total number of JavaScript, CSS, and Image files currently loaded in
	 * `state.libraries` and updates the badge numbers inside the category filter tabs.
	 */
	function updateCategoryCounts() {
		let jsCount = 0;
		let cssCount = 0;
		let imgCount = 0;

		state.libraries.forEach((lib) => {
			// Sum up the number of files across all versions of this library
			const fileCount = lib.versions.reduce((sum, v) => sum + v.files.length, 0);
			if (lib.type === 'js') jsCount += fileCount;
			if (lib.type === 'css') cssCount += fileCount;
			if (lib.type === 'img') imgCount += fileCount;
		});

		els.countAll.textContent = jsCount + cssCount + imgCount;
		els.countJs.textContent = jsCount;
		els.countCss.textContent = cssCount;
		if (els.countImg) els.countImg.textContent = imgCount;
	}

	/**
	 * Counts the total number of individual files across an array of library objects.
	 *
	 * @param {Array<Object>} libraries - Array of grouped library objects.
	 * @returns {number} Total file count.
	 */
	function countTotalFiles(libraries) {
		return libraries.reduce(
			(sum, lib) => sum + lib.versions.reduce((vSum, v) => vSum + v.files.length, 0),
			0
		);
	}

	/**
	 * Shows or hides the loading spinner panel while asset discovery is in progress.
	 *
	 * @param {boolean} isLoading - True to show the spinner, false to hide it.
	 */
	function setLoading(isLoading) {
		els.loadingState.hidden = !isLoading;
		if (isLoading) {
			els.librariesGrid.innerHTML = '';
			els.emptyState.hidden = true;
		}
	}

	/**
	 * Updates the status pill in the top header bar to show whether assets are
	 * currently loaded from Azure Live XML (green dot) or Local Dev Server (blue dot).
	 *
	 * @param {'online'|'local'|'connecting'} mode - Visual state of the status indicator dot.
	 * @param {string} text                        - Status label text to display.
	 */
	function updateStatus(mode, text) {
		els.sourceStatusDot.className = 'status-dot';
		if (mode === 'online') els.sourceStatusDot.classList.add('online');
		if (mode === 'local') els.sourceStatusDot.classList.add('local');
		els.sourceStatusText.textContent = text;
	}

	/**
	 * Creates and displays a temporary pop-up toast notification in the bottom-right
	 * corner of the screen, then automatically removes it after 2.6 seconds.
	 *
	 * @param {string} message - Notification text to display.
	 */
	function showToast(message) {
		const toast = document.createElement('div');
		toast.className = 'toast';
		toast.innerHTML = `
			<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" stroke="#F2A900" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
				<polyline points="20 6 9 17 4 12"></polyline>
			</svg>
			<span>${escapeHtml(message)}</span>
		`;
		els.toastContainer.appendChild(toast);
		setTimeout(() => {
			toast.remove();
		}, 2600);
	}

	/**
	 * Converts a raw byte count (e.g., `87532`) into a human-readable file size
	 * string (`"85.5 KB"` or `"1.24 MB"`).
	 *
	 * @param {number|null} bytes - File size in bytes from Azure XML `<Content-Length>`.
	 * @returns {string} Formatted size string, or empty string if unknown.
	 */
	function formatBytes(bytes) {
		if (!bytes || isNaN(bytes)) return '';
		if (bytes < 1024) return `${bytes} B`;
		const kb = bytes / 1024;
		if (kb < 1024) return `${kb.toFixed(1)} KB`;
		return `${(kb / 1024).toFixed(2)} MB`;
	}

	/**
	 * Formats a date string (such as Azure's `<Last-Modified>` header) into a concise,
	 * readable date like `"Nov 3, 2026"`.
	 *
	 * @param {string|null} dateStr - Raw date string.
	 * @returns {string} Formatted short date, or empty string if invalid.
	 */
	function formatShortDate(dateStr) {
		const d = new Date(dateStr);
		if (isNaN(d.getTime())) return '';
		return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
	}

	/**
	 * Security helper: Escapes special HTML characters (`&`, `<`, `>`, `"`, `'`)
	 * before inserting dynamic strings into `.innerHTML` templates.
	 *
	 * @param {string} str - Raw string to escape.
	 * @returns {string} HTML-safe string.
	 */
	function escapeHtml(str) {
		return String(str)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	// Start the application once the browser has finished parsing the HTML DOM
	document.addEventListener('DOMContentLoaded', init);
})();
