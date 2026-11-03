/**
 * ============================================================================
 * Johns Hopkins Medicine - Global Assets Portal (/js/site.js)
 * ============================================================================
 *
 * PURPOSE:
 * This file powers the user interface for the Johns Hopkins Medicine Global
 * Assets repository. It dynamically discovers CSS and JavaScript files hosted
 * in the repository, groups them by library and version, and renders an
 * interactive UI where users can search, filter, and copy CDN links.
 *
 * HOW DYNAMIC ASSET DISCOVERY WORKS (3-Tier Architecture):
 * 1. Tier 1 - Azure Blob Storage Live XML Listing:
 *    Queries Azure's built-in container listing API (?restype=container&comp=list).
 *    Automatically finds any files matching:
 *      - css/cdn/{library}/{version}/{file}
 *      - js/cdn/{library}/{version}/{file}
 *
 * 2. Tier 2 - Local Dev Server Folder Auto-Crawler:
 *    When running locally on a developer's machine (e.g., VS Code Live Server
 *    on localhost / 127.0.0.1), it crawls the HTML directory listings of
 *    /css/cdn/ and /js/cdn/ so newly added folders/files appear immediately
 *    on browser refresh without needing to upload to Azure first.
 *
 * 3. Tier 3 - Built-in Fallback Manifest:
 *    If a developer double-clicks index.html directly from File Explorer
 *    (file:// protocol where browsers block fetch requests), it uses a
 *    fallback list so the UI still renders a preview.
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
	 * Regular Expression used to validate and extract metadata from a file's path.
	 *
	 * Breakdown of `^\/?(css|js)\/cdn\/([^/]+)\/([^/]+)\/(.+)$`:
	 * - `^\/?`       : Optional leading slash at the start of the path
	 * - `(css|js)`   : Capture Group 1 -> Asset type ('css' or 'js')
	 * - `\/cdn\/`    : Must be inside the `/cdn/` folder (ignores site.css and site.js!)
	 * - `([^/]+)`    : Capture Group 2 -> Library folder name (e.g., 'jquery', 'font-awesome')
	 * - `\/([^/]+)\/`: Capture Group 3 -> Version folder name (e.g., '4.1', '4.7', '5.3')
	 * - `(.+)$`      : Capture Group 4 -> File name (or nested subpath, e.g., 'jquery.min.js')
	 */
	const CDN_PATH_REGEX = /^\/?(css|js)\/cdn\/([^/]+)\/([^/]+)\/(.+)$/i;

	/**
	 * Fallback asset list used ONLY when both Local Server crawling and Azure XML
	 * discovery return 0 files (for example, opening index.html offline via file://).
	 */
	const FALLBACK_PATHS = [
		{ path: 'css/cdn/font-awesome/4.1/font-awesome.min.css', size: 125, lastModified: null },
		{ path: 'css/cdn/font-awesome/5.3/all.min.css', size: 224, lastModified: null },
		{ path: 'js/cdn/jquery/4.1/jquery.min.js', size: 112, lastModified: null },
		{ path: 'js/cdn/jquery/4.7/jquery.min.js', size: 113, lastModified: null },
		{ path: 'js/cdn/jquery/5.3/jquery.min.js', size: 112, lastModified: null }
	];

	/**
	 * Central Application State.
	 * Keeping all UI state in one object makes it easy to understand what the UI
	 * is currently showing and re-render cleanly whenever the user types or clicks.
	 */
	const state = {
		libraries: [],          // Array of grouped library objects (created by groupAssetsIntoLibraries)
		activeFilter: 'all',    // Currently selected category tab: 'all' | 'js' | 'css'
		searchQuery: '',        // Current lowercase text in the search box
		baseUrl: DEFAULT_AZURE_CONTAINER_URL, // Root CDN URL prepended to relative file paths
		sourceMode: 'auto',     // Discovery mode selected in dropdown: 'auto' | 'azure' | 'local'
		activeSourceLabel: ''   // Human-readable name of the source currently in use
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
	   1. Initialization & Setup Functions
	   ========================================================================== */

	/**
	 * Main entry point called once the HTML document finishes loading.
	 * Sets up the visual theme, detects the base URL, attaches event listeners,
	 * and kicks off the initial asset discovery scan.
	 */
	function init() {
		initTheme();
		initBaseUrl();
		bindEvents();
		discoverAssets();
	}

	/**
	 * Determines whether to start in Light or Dark mode.
	 * Checks `localStorage` first in case the user previously chose a theme;
	 * otherwise falls back to the user's operating system preference.
	 */
	function initTheme() {
		const savedTheme = localStorage.getItem('jhm_assets_theme');
		const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
		const theme = savedTheme || (prefersDark ? 'dark' : 'light');
		applyTheme(theme);
	}

	/**
	 * Applies the chosen theme ('light' or 'dark') to the root `<html>` element
	 * via `data-theme="..."` (which CSS variables in `site.css` respond to),
	 * saves the choice to `localStorage`, and swaps the Sun/Moon button icon.
	 *
	 * @param {'light'|'dark'} theme - The theme to activate.
	 */
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

	/**
	 * Automatically detects the Azure container root URL if `index.html` is
	 * currently being viewed directly on `*.blob.core.windows.net`.
	 *
	 * Example:
	 * If the browser is at `https://jhmcdn.blob.core.windows.net/global-assets/index.html`,
	 * `loc.pathname.split('/').filter(Boolean)` produces `['global-assets', 'index.html']`.
	 * Taking `parts[0]` gives us the container name (`global-assets`), so the base URL
	 * is automatically set to `https://jhmcdn.blob.core.windows.net/global-assets`.
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
		}
	}

	/**
	 * Registers all top-level UI event listeners (search bar, keyboard shortcuts,
	 * category filter tabs, source dropdown, base URL input, sync button, and theme toggle).
	 */
	function bindEvents() {
		// 1. Live Search Input: re-renders the grid on every keystroke
		els.searchInput.addEventListener('input', (e) => {
			state.searchQuery = e.target.value.trim().toLowerCase();
			render();
		});

		// 2. Keyboard Shortcut: pressing '/' anywhere (when not already typing in an input)
		//    immediately focuses the search box for quick lookup.
		document.addEventListener('keydown', (e) => {
			if (e.key === '/' && document.activeElement !== els.searchInput && document.activeElement !== els.baseUrlInput) {
				e.preventDefault(); // Prevents '/' from being typed into the search input itself
				els.searchInput.focus();
			}
		});

		// 3. Category Filter Tabs ('All Assets', 'JavaScript', 'Stylesheets')
		els.filterTabs.forEach((tab) => {
			tab.addEventListener('click', () => {
				// First, remove the active highlight from all tabs
				els.filterTabs.forEach((t) => {
					t.classList.remove('active');
					t.setAttribute('aria-selected', 'false');
				});
				// Then highlight the clicked tab and update state.activeFilter
				tab.classList.add('active');
				tab.setAttribute('aria-selected', 'true');
				state.activeFilter = tab.dataset.filter;
				render();
			});
		});

		// 4. Discovery Source Dropdown ('auto', 'azure', 'local')
		els.sourceModeSelect.addEventListener('change', (e) => {
			state.sourceMode = e.target.value;
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
				t.setAttribute('aria-selected', isAll ? 'true' : 'false');
			});
			render();
		});

		// 8. Dark / Light Mode Toggle Button
		els.themeToggleBtn.addEventListener('click', () => {
			const current = document.documentElement.getAttribute('data-theme');
			applyTheme(current === 'dark' ? 'light' : 'dark');
		});
	}

	/* ==========================================================================
	   2. Dynamic Asset Discovery Engine (Azure Live XML + Local Folder Crawler)
	   ========================================================================== */

	/**
	 * Orchestrates asset discovery across our 3 tiers based on the current environment
	 * and the user's selected `state.sourceMode`.
	 *
	 * @param {boolean} [isManualRefresh=false] - True if triggered by clicking the "Sync" button
	 *                                            (shows a toast notification when finished).
	 */
	async function discoverAssets(isManualRefresh = false) {
		setLoading(true);
		updateStatus('connecting', 'Scanning repository...');

		// Check if the developer is running on a local web server (e.g., VS Code Live Server)
		// or opening the HTML file directly from their hard drive (`file://`).
		const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
		const isFileProtocol = window.location.protocol === 'file:';

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
				// STEP 1: If running on localhost, crawl local `/css/cdn/` and `/js/cdn/` first.
				// This lets developers add a folder locally and see it immediately on refresh!
				if (isLocalhost) {
					items = await crawlLocalCdnDirectories();
					if (items.length > 0) {
						sourceUsed = 'Local Dev Server (/cdn/)';
					}
				}

				// STEP 2: If not on localhost (or local crawl returned nothing), query Azure Blob Live XML.
				if (items.length === 0) {
					const azureItems = await fetchFromAzureBlobXml(state.baseUrl);
					if (azureItems.length > 0) {
						items = azureItems;
						sourceUsed = 'Azure Blob Live';
					}
				}

				// STEP 3: Handle empty container or offline `file://` preview.
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
	 * returns an XML document listing up to 5,000 blobs at a time:
	 *   <EnumerationResults>
	 *     <Blobs>
	 *       <Blob>
	 *         <Name>js/cdn/jquery/5.3/jquery.min.js</Name>
	 *         <Properties>
	 *           <Content-Length>87532</Content-Length>
	 *           <Last-Modified>Tue, 03 Nov 2026 14:34:04 GMT</Last-Modified>
	 *         </Properties>
	 *       </Blob>
	 *     </Blobs>
	 *     <NextMarker>...</NextMarker>
	 *   </EnumerationResults>
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

				// Only keep files that match our `/css/cdn/...` or `/js/cdn/...` convention.
				// This automatically ignores `index.html`, `css/site.css`, `js/site.js`, `img/*`, etc.
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

			// Check if Azure returned a pagination marker for the next page of results
			const nextMarkerNode = xmlDoc.querySelector('NextMarker');
			marker = nextMarkerNode && nextMarkerNode.textContent ? nextMarkerNode.textContent.trim() : '';
		} while (marker);

		return discovered;
	}

	/**
	 * TIER 2 DISCOVERY: Crawls local `/css/cdn/` and `/js/cdn/` folders when running
	 * on a local development server (such as VS Code Live Server, Python http.server, etc.).
	 *
	 * @returns {Promise<Array<{path: string, size: number|null, lastModified: string|null}>>}
	 */
	async function crawlLocalCdnDirectories() {
		const roots = ['css/cdn/', 'js/cdn/'];
		const discovered = [];

		for (const root of roots) {
			try {
				const files = await crawlDirectoryRecursive(root, 0);
				discovered.push(...files);
			} catch (_) {
				// Ignore errors if a folder doesn't exist yet or directory browsing is disabled
			}
		}

		// Optional secondary local fallback: if the local server has directory listing
		// turned off, check if a static `js/assets-manifest.json` file exists.
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
				// Ignore if manifest file is not present
			}
		}

		return discovered;
	}

	/**
	 * Recursively walks a local directory listing HTML page returned by a dev server
	 * (like VS Code Live Server) to find all nested asset files.
	 *
	 * How this works step-by-step for a junior developer:
	 * 1. When you request a folder URL like `http://127.0.0.1:5500/js/cdn/` from Live Server,
	 *    Live Server responds with an HTML web page containing `<a href="...">` links for
	 *    every subfolder (`jquery`) and file inside that directory.
	 * 2. We fetch that HTML, parse it into a virtual DOM document using `DOMParser`, and
	 *    extract all `<a href="...">` tags.
	 * 3. For each link:
	 *    - If it's a subfolder (like `jquery` or version folder `4.7`), this function calls
	 *      itself recursively (`crawlDirectoryRecursive`) to look inside that subfolder.
	 *    - If it's an actual asset file (like `jquery.min.js`), we add it to our results list!
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
			// so `relPath` always starts cleanly with `css/cdn/` or `js/cdn/`.
			const matchIdx = relPath.search(/(css|js)\/cdn\//i);
			if (matchIdx > 0) {
				relPath = relPath.slice(matchIdx);
			}

			// Crucial safety check: ignore any link that points *outside* or *above* the
			// directory we are currently scanning (such as a "Parent Directory" link).
			if (!relPath.startsWith(dirPath.replace(/^\/+/, ''))) {
				continue;
			}

			// Determine whether this link is a SUBFOLDER or a FILE:
			// Tricky edge case: Version folders are named things like "4.7" or "5.3.1".
			// Notice that "4.7" contains a dot! And VS Code Live Server does NOT put a
			// trailing slash on folder links (`href="/js/cdn/jquery/4.7"`).
			// So if we checked "does it have a dot?", we would mistakenly think folder "4.7"
			// is a file with a ".7" extension!
			// Instead, we check if the last segment ends with a real web asset file extension.
			const lastSegment = relPath.replace(/\/+$/, '').split('/').pop() || '';
			const isKnownAssetFile = /\.(js|mjs|cjs|css|map|woff2?|ttf|eot|svg|otf|json|png|jpg|jpeg|gif|webp|ico)$/i.test(lastSegment);

			if (rawHref.endsWith('/') || !isKnownAssetFile) {
				// It's a folder (e.g., 'jquery' or '4.7') -> recurse inside it!
				const subDir = relPath.endsWith('/') ? relPath : `${relPath}/`;
				const subFiles = await crawlDirectoryRecursive(subDir, depth + 1);
				results.push(...subFiles);
			} else if (CDN_PATH_REGEX.test(relPath)) {
				// It's a valid asset file inside `/css/cdn/...` or `/js/cdn/...` -> record it!
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
	 * Input example (flat array):
	 *   [
	 *     { path: 'js/cdn/jquery/4.1/jquery.min.js' },
	 *     { path: 'js/cdn/jquery/5.3/jquery.min.js' }
	 *   ]
	 *
	 * Output example (grouped by Library -> Versions -> Files):
	 *   [
	 *     {
	 *       id: 'js:jquery',
	 *       type: 'js',
	 *       name: 'jquery',
	 *       displayName: 'jQuery',
	 *       selectedVersion: 'all',
	 *       versions: [
	 *         { version: '5.3', files: [{ fileName: 'jquery.min.js', ... }] },
	 *         { version: '4.1', files: [{ fileName: 'jquery.min.js', ... }] }
	 *       ]
	 *     }
	 *   ]
	 *
	 * @param {Array<{path: string, size?: number|null, lastModified?: string|null}>} items
	 * @returns {Array<Object>} Sorted array of library objects.
	 */
	function groupAssetsIntoLibraries(items) {
		// We use a JavaScript `Map` keyed by `type:libraryName` (e.g., `js:jquery`)
		// so if a library has both CSS and JS files, they get separate CSS and JS cards.
		const libMap = new Map();

		items.forEach((item) => {
			const normalizedPath = item.path.replace(/^\/+/, '');

			// Run the path through our regex to extract [fullMatch, type, libraryName, version, fileName]
			const match = normalizedPath.match(CDN_PATH_REGEX);
			if (!match) return;

			const type = match[1].toLowerCase();      // 'css' | 'js'
			const libraryName = match[2];             // e.g. 'font-awesome', 'jquery'
			const version = match[3];                 // e.g. '4.1', '4.7', '5.3'
			const fileName = match[4];                // e.g. 'all.min.css'

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

		// Finally, sort the library cards alphabetically by library name (e.g. Font Awesome, then jQuery)
		return libraries.sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Compares two version strings (like "4.1", "4.10", "5.3.1") in DESCENDING order
	 * (newest version first).
	 *
	 * Why we can't just use standard string `.sort()`:
	 * In alphabetical string sorting, `"4.10"` comes BEFORE `"4.2"` because character `'1'`
	 * is smaller than `'2'`. By splitting the version string on `.` and `-` and converting
	 * each part into a real `Number`, `10` is properly compared as greater than `2`!
	 *
	 * @param {string} vA - First version string.
	 * @param {string} vB - Second version string.
	 * @returns {number} Positive if vB > vA, negative if vA > vB, 0 if equal.
	 */
	function compareSemverDesc(vA, vB) {
		// Split "5.3.1" into [5, 3, 1]
		const partsA = String(vA).split(/[.-]/).map((n) => (isNaN(n) ? n : Number(n)));
		const partsB = String(vB).split(/[.-]/).map((n) => (isNaN(n) ? n : Number(n)));
		const len = Math.max(partsA.length, partsB.length);

		for (let i = 0; i < len; i++) {
			// Use `?? 0` so "5.3" is treated as "5.3.0" when compared against "5.3.1"
			const a = partsA[i] ?? 0;
			const b = partsB[i] ?? 0;
			if (a !== b) {
				// Return `b > a ? 1 : -1` for descending order (highest version first)
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
		// Dictionary of popular libraries with special capitalization
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

		// For any other folder name, split by hyphens/underscores and capitalize each word:
		// e.g., "my-custom-script" -> ["my", "custom", "script"] -> "My Custom Script"
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
			// 1. Check Category Tab filter ('all', 'js', or 'css')
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
		const isJs = lib.type === 'js';
		const badgeLabel = isJs ? 'JavaScript' : 'Stylesheet';
		const badgeClass = isJs ? 'type-js' : 'type-css';
		const folderPrefix = `/${lib.type}/cdn/${lib.name}/`;

		// Build the `<option>` tags for the card's Version dropdown.
		// Since `lib.versions` is already sorted newest-first, index `0` is marked `(Latest)`.
		const versionOptions = [
			`<option value="all" ${lib.selectedVersion === 'all' ? 'selected' : ''}>All Versions (${lib.versions.length})</option>`,
			...lib.versions.map((v, idx) => {
				const latestSuffix = idx === 0 ? ' (Latest)' : '';
				const selected = lib.selectedVersion === v.version ? 'selected' : '';
				return `<option value="${escapeHtml(v.version)}" ${selected}>v${escapeHtml(v.version)}${latestSuffix}</option>`;
			})
		].join('');

		// Render each file row inside the card
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

	/**
	 * Generates the HTML string for an individual file row inside a Library Card,
	 * including its version tag, filename, full CDN URL preview, and Copy buttons.
	 *
	 * @param {Object} lib  - The parent library object ('js' or 'css').
	 * @param {Object} file - The file metadata object (`fileName`, `version`, `relativePath`, etc.).
	 * @returns {string} HTML markup for `<div class="file-row">`.
	 */
	function renderFileRow(lib, file) {
		const fullUrl = buildFullAssetUrl(file.relativePath);
		const htmlSnippet = buildHtmlTagSnippet(lib.type, fullUrl);
		const tagButtonLabel = lib.type === 'js' ? 'Copy &lt;script&gt;' : 'Copy &lt;link&gt;';

		// Optional metadata (file size in KB/MB and last modified date when loaded from Azure XML)
		const metaParts = [];
		if (file.size) metaParts.push(formatBytes(file.size));
		if (file.lastModified) metaParts.push(`Updated ${formatShortDate(file.lastModified)}`);
		const metaHtml = metaParts.length > 0 ? `<span class="file-meta">&bull; ${escapeHtml(metaParts.join(' • '))}</span>` : '';

		// Note: We store the exact string to copy inside `data-copy-text="..."` attributes
		// on the buttons so `bindCardEvents()` can read it when clicked.
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

	/**
	 * Attaches event listeners to dynamically rendered elements inside the Library Cards
	 * (specifically the per-card Version `<select>` dropdowns and the Copy buttons).
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
		document.querySelectorAll('.btn-copy').forEach((btn) => {
			btn.addEventListener('click', async () => {
				const textToCopy = btn.dataset.copyText;
				const label = btn.dataset.copyLabel || 'Text';
				await copyToClipboard(textToCopy, btn, label);
			});
		});
	}

	/* ==========================================================================
	   5. Helper & Utility Functions
	   ========================================================================== */

	/**
	 * Combines the configured Base CDN URL (`state.baseUrl`) with a file's relative path
	 * to produce a complete HTTPS URL.
	 *
	 * Example:
	 *   base:         "https://jhmcdn.blob.core.windows.net/global-assets"
	 *   relativePath: "js/cdn/jquery/4.7/jquery.min.js"
	 *   returns:      "https://jhmcdn.blob.core.windows.net/global-assets/js/cdn/jquery/4.7/jquery.min.js"
	 *
	 * @param {string} relativePath - Path starting with `css/cdn/...` or `js/cdn/...`.
	 * @returns {string} Complete URL to the asset.
	 */
	function buildFullAssetUrl(relativePath) {
		// `.replace(/\/+$/, '')` removes any trailing slashes from the base URL
		const base = (state.baseUrl || DEFAULT_AZURE_CONTAINER_URL).replace(/\/+$/, '');
		// `.replace(/^\/+/, '')` removes any leading slashes from the relative path
		const cleanRel = relativePath.replace(/^\/+/, '');
		return `${base}/${cleanRel}`;
	}

	/**
	 * Builds a ready-to-paste HTML `<link>` or `<script>` tag for a given asset URL.
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
			// Modern asynchronous Clipboard API (supported in all modern browsers over HTTPS or localhost)
			if (navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(text);
			} else {
				// Legacy fallback for older browsers or non-secure contexts (e.g. file:// protocol):
				// Creates an invisible <textarea>, selects the text inside it, and runs `execCommand('copy')`.
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
	 * Calculates the total number of JavaScript and CSS files currently loaded in
	 * `state.libraries` and updates the badge numbers inside the category filter tabs.
	 */
	function updateCategoryCounts() {
		let jsCount = 0;
		let cssCount = 0;

		state.libraries.forEach((lib) => {
			// Sum up the number of files across all versions of this library
			const fileCount = lib.versions.reduce((sum, v) => sum + v.files.length, 0);
			if (lib.type === 'js') jsCount += fileCount;
			if (lib.type === 'css') cssCount += fileCount;
		});

		els.countAll.textContent = jsCount + cssCount;
		els.countJs.textContent = jsCount;
		els.countCss.textContent = cssCount;
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
	 * Why this is important:
	 * It prevents broken HTML markup (for example, when storing `<script src="...">` inside
	 * a `data-copy-text="..."` attribute) and protects against Cross-Site Scripting (XSS).
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
