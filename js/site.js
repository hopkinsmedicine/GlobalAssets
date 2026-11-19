/**
 * ============================================================================
 * Johns Hopkins Medicine — Global Assets Portal Logic (js/site.js)
 * Branch: img-handler-cdn-alt-2 (Predefined Image Metadata Array Edition)
 * ============================================================================
 *
 * PURPOSE OF THIS FILE:
 * This script powers the Global Assets web portal. Its job is to:
 *   1. Automatically discover all CSS, JS, and Image files inside `/css/cdn/`,
 *      `/js/cdn/`, and `/img/cdn/`.
 *   2. Match discovered images against the predefined `images` metadata array
 *      below so every image has official, pre-approved `alt` and `figcaption`
 *      text ready to use.
 *   3. Group discovered files by Library/Category Name and Version.
 *   4. Render interactive cards on the page so users can search, filter by
 *      category or version, and copy ready-to-use URLs or HTML tags (`<script>`,
 *      `<link>`, `<img>`, or `<figure>` + `<figcaption>`).
 *
 * HOW ASSET DISCOVERY WORKS (2-Tier Strategy):
 *   - Tier 1 (Azure Blob Storage XML API):
 *     In production, the portal queries Azure's public container listing XML:
 *     `https://jhmcdn.blob.core.windows.net/global-assets?restype=container&comp=list`
 *   - Tier 2 (Local Dev Server Folder Crawler):
 *     When a developer runs a local web server (like VS Code "Live Server" on
 *     `localhost` or `127.0.0.1`), the script crawls the local `/css/cdn/`,
 *     `/js/cdn/`, and `/img/cdn/` folders so you can test new files before
 *     uploading to Azure.
 * ============================================================================
 */

/* ==========================================================================
   PREDEFINED IMAGE METADATA CATALOG (`images` Array)
   ==========================================================================
   DEVELOPER INSTRUCTIONS:
   Every time a new image is added inside the `/img/cdn/` directory, add a
   matching object to this `images` array with:
     - `source`: Path to the image inside `/img/cdn/` (supports `../img/cdn/...`,
                 `img/cdn/...`, or `../images/cdn/...`)
     - `alt`: Predefined accessible alternative text for the `alt=""` attribute
     - `figcaption`: Predefined caption text for the `<figcaption>` element
   ========================================================================== */
const images = [
	{
		source: '../img/cdn/logos/jhm-logo.png',
		alt: 'Johns Hopkins Medicine official horizontal logo',
		figcaption: 'Johns Hopkins Medicine — Official Brand Mark'
	}
	// Add additional images below to match what is inside /img/cdn/:
	// {
	// 	source: '../img/cdn/logos/example-image.png',
	// 	alt: 'Image alt text',
	// 	figcaption: 'Image figcaption text'
	// }
];

(function () {
	'use strict';

	/* ==========================================================================
	   1. CONFIGURATION CONSTANTS
	   ========================================================================== */

	/**
	 * The production URL of the Azure Blob Storage container.
	 * Used as the default Base URL when generating copyable CDN links.
	 */
	const DEFAULT_AZURE_CONTAINER_URL = 'https://jhmcdn.blob.core.windows.net/global-assets';

	/**
	 * Supported image file extensions for `/img/cdn/` assets.
	 */
	const IMAGE_EXTENSIONS_REGEX = /\.(png|jpe?g|svg|gif|webp|avif|ico)$/i;

	/* ==========================================================================
	   2. APPLICATION STATE
	   ==========================================================================
	   `state` holds the current runtime data for the UI:
	   - `baseUrl`: The root URL prepended to every asset path when copying links.
	   - `filterCategory`: Which tab is active ('all', 'js', 'css', or 'img').
	   - `searchQuery`: Current text typed into the search box.
	   - `selectedVersions`: Remembers which version dropdown option a user
	     picked on a specific library card (keyed by `"type:library"`).
	   - `libraries`: Array of grouped library objects built from the raw file list.
	   - `modal`: State for the interactive "Generate Tag" image modal.
	   ========================================================================== */
	const state = {
		baseUrl: DEFAULT_AZURE_CONTAINER_URL,
		filterCategory: 'all',
		searchQuery: '',
		selectedVersions: {},
		libraries: [],
		modal: {
			isOpen: false,
			mode: 'img', // 'img' or 'figure'
			fileUrl: '',
			fileName: '',
			predefinedAlt: '',
			predefinedFigcaption: '',
			hasPredefinedMatch: false,
			isUnlockedForCustomEdit: false,
			lastFocusedElement: null
		}
	};

	/* ==========================================================================
	   3. DOM ELEMENT REFERENCES
	   ========================================================================== */
	const dom = {
		searchInput: document.getElementById('searchInput'),
		filterTabs: document.querySelectorAll('.filter-tab'),
		sourceModeSelect: document.getElementById('sourceModeSelect'),
		baseUrlInput: document.getElementById('baseUrlInput'),
		refreshBtn: document.getElementById('refreshBtn'),
		resetSearchBtn: document.getElementById('resetSearchBtn'),
		assetsGrid: document.getElementById('assetsGrid'),
		loadingState: document.getElementById('loadingState'),
		emptyState: document.getElementById('emptyState'),
		statusDot: document.getElementById('statusDot'),
		statusText: document.getElementById('statusText'),
		countAll: document.getElementById('countAll'),
		countJs: document.getElementById('countJs'),
		countCss: document.getElementById('countCss'),
		countImg: document.getElementById('countImg'),
		toast: document.getElementById('toast'),

		// Image Tag Generator Modal DOM Elements
		imgTagModalBackdrop: document.getElementById('imgTagModalBackdrop'),
		closeImgModalBtn: document.getElementById('closeImgModalBtn'),
		cancelImgModalBtn: document.getElementById('cancelImgModalBtn'),
		modalImgPreview: document.getElementById('modalImgPreview'),
		modalImgName: document.getElementById('modalImgName'),
		modalImgUrl: document.getElementById('modalImgUrl'),
		modalPredefinedBadge: document.getElementById('modalPredefinedBadge'),
		modalLockStatusText: document.getElementById('modalLockStatusText'),
		toggleEditPredefinedBtn: document.getElementById('toggleEditPredefinedBtn'),
		modeImgOnlyBtn: document.getElementById('modeImgOnlyBtn'),
		modeFigureBtn: document.getElementById('modeFigureBtn'),
		modalAltInput: document.getElementById('modalAltInput'),
		modalCaptionGroup: document.getElementById('modalCaptionGroup'),
		modalCaptionInput: document.getElementById('modalCaptionInput'),
		modalCodeOutput: document.getElementById('modalCodeOutput'),
		copyModalTagBtn: document.getElementById('copyModalTagBtn'),
		copyModalTagText: document.getElementById('copyModalTagText')
	};

	/* ==========================================================================
	   4. PREDEFINED IMAGE METADATA LOOKUP HELPER
	   ========================================================================== */

	/**
	 * Normalizes an image path from either the `images` array (`source`) or the
	 * CDN discovery engine (`relativePath`) so they can be compared reliably.
	 *
	 * Examples of input paths that all normalize to `"img/cdn/logos/jhm-logo.png"`:
	 *   - `"../img/cdn/logos/jhm-logo.png"`
	 *   - `"../images/cdn/logos/jhm-logo.png"`
	 *   - `"/img/cdn/logos/jhm-logo.png"`
	 *   - `"img/cdn/logos/jhm-logo.png"`
	 *
	 * @param {string} rawPath
	 * @returns {string} Normalized path starting with `img/cdn/`
	 */
	function normalizeImageSourcePath(rawPath) {
		let cleaned = String(rawPath || '')
			.trim()
			.replace(/\\/g, '/')
			.replace(/^(\.\.\/|\.\/|\/)+/, '');

		// Allow developers to write either `images/cdn/...` or `img/cdn/...` in `images[]`
		cleaned = cleaned.replace(/^images\/cdn\//i, 'img/cdn/');

		// If the path contains `img/cdn/` after a prefix, slice from `img/cdn/`
		const cdnIdx = cleaned.toLowerCase().indexOf('img/cdn/');
		if (cdnIdx !== -1) {
			cleaned = cleaned.slice(cdnIdx);
		}

		return cleaned.toLowerCase();
	}

	/**
	 * Searches the predefined `images` array for an entry matching the given
	 * discovered CDN image file.
	 *
	 * Matching priority:
	 *   1. Exact normalized path match (e.g. `img/cdn/logos/jhm-logo.png`)
	 *   2. Suffix match on `category/filename` or `filename` if a shorthand
	 *      `source` was used in the `images` array.
	 *
	 * @param {string} relativePath - Discovered CDN path (e.g. `img/cdn/logos/jhm-logo.png`)
	 * @param {string} fileName     - Discovered filename (e.g. `jhm-logo.png`)
	 * @returns {{ source: string, alt: string, figcaption: string } | null}
	 */
	function findPredefinedImageMeta(relativePath, fileName) {
		if (!Array.isArray(images) || images.length === 0) return null;

		const targetNormalized = normalizeImageSourcePath(relativePath);
		const targetFileLower = String(fileName || '').toLowerCase();

		// 1. Try exact normalized path match first
		for (const item of images) {
			if (!item || !item.source) continue;
			const candidateNormalized = normalizeImageSourcePath(item.source);
			if (candidateNormalized === targetNormalized) {
				return {
					source: item.source,
					alt: String(item.alt || ''),
					figcaption: String(item.figcaption || '')
				};
			}
		}

		// 2. Fallback: match by filename at the end of `source`
		for (const item of images) {
			if (!item || !item.source) continue;
			const candidateNormalized = normalizeImageSourcePath(item.source);
			const candidateFileName = candidateNormalized.split('/').pop();
			if (candidateFileName && candidateFileName === targetFileLower) {
				return {
					source: item.source,
					alt: String(item.alt || ''),
					figcaption: String(item.figcaption || '')
				};
			}
		}

		return null;
	}

	/* ==========================================================================
	   5. CDN PATH PARSER (`css/cdn/`, `js/cdn/`, and `img/cdn/`)
	   ========================================================================== */

	/**
	 * Parses a relative CDN file path into its structured components:
	 *   - `type`: `'css'`, `'js'`, or `'img'`
	 *   - `library`: Library or image category folder slug (e.g. `'jquery'`, `'logos'`)
	 *   - `version`: Version folder name (e.g. `'5.3.8'`), or `'latest'` for flat image folders
	 *   - `fileName`: The file name (e.g. `'jquery.min.js'` or `'jhm-logo.png'`)
	 *
	 * Supported directory patterns:
	 *   1. Standard versioned library/asset:
	 *      `{css|js|img}/cdn/{library}/{version}/{file}`
	 *   2. Flat category folder for images (no version subfolder needed; version can be in filename):
	 *      `img/cdn/{category}/{file}` -> `library = category`, `version = 'latest'`
	 *   3. Root image inside `img/cdn/`:
	 *      `img/cdn/{file}` -> `library = 'general'`, `version = 'latest'`
	 *
	 * @param {string} rawRelativePath
	 * @returns {{ type: string, library: string, version: string, fileName: string, relativePath: string } | null}
	 */
	function parseCdnAssetPath(rawRelativePath) {
		const cleanPath = String(rawRelativePath || '').replace(/^\/+/, '');

		// 1. Check `css/cdn/{library}/{version}/{file}` or `js/cdn/{library}/{version}/{file}`
		const cssJsMatch = cleanPath.match(/^(css|js)\/cdn\/([^/]+)\/([^/]+)\/(.+)$/i);
		if (cssJsMatch) {
			const type = cssJsMatch[1].toLowerCase();
			const library = cssJsMatch[2];
			const version = cssJsMatch[3];
			const fileName = cssJsMatch[4];
			if (!/\.(css|js|map)$/i.test(fileName)) return null;
			return { type, library, version, fileName, relativePath: cleanPath };
		}

		// 2. Check `img/cdn/...`
		if (/^img\/cdn\//i.test(cleanPath)) {
			const parts = cleanPath.split('/');
			const fileName = parts[parts.length - 1];
			if (!IMAGE_EXTENSIONS_REGEX.test(fileName)) return null;

			if (parts.length === 3) {
				// Pattern: img/cdn/{file}
				return {
					type: 'img',
					library: 'general',
					version: 'latest',
					fileName,
					relativePath: cleanPath
				};
			} else if (parts.length === 4) {
				// Pattern: img/cdn/{category}/{file} (e.g., img/cdn/logos/jhm-logo.png)
				return {
					type: 'img',
					library: parts[2],
					version: 'latest',
					fileName,
					relativePath: cleanPath
				};
			} else if (parts.length >= 5) {
				// Pattern: img/cdn/{category}/{version}/{file}
				return {
					type: 'img',
					library: parts[2],
					version: parts[3],
					fileName: parts.slice(4).join('/'),
					relativePath: cleanPath
				};
			}
		}

		return null;
	}

	/* ==========================================================================
	   6. ASSET DISCOVERY ENGINE (AZURE XML + LOCAL DEV CRAWLER)
	   ========================================================================== */

	/**
	 * Main entry point for scanning and loading CDN assets.
	 *
	 * How it decides where to scan:
	 *   - If the user explicitly selected "Azure Blob Live XML" or "Local /cdn/ Folders"
	 *     in the Source dropdown, it honors that choice.
	 *   - If set to "Auto (Smart Detect)":
	 *       * On `localhost` / `127.0.0.1`, it crawls the local folders first so
	 *         developers can test new files immediately.
	 *       * In production (Azure), it queries the Azure Blob XML API first.
	 */
	async function discoverAssets() {
		setLoading(true);
		const mode = dom.sourceModeSelect ? dom.sourceModeSelect.value : 'auto';
		const isLocalhost =
			window.location.hostname === 'localhost' ||
			window.location.hostname === '127.0.0.1';

		try {
			// Mode 1: Developer forced "Local /cdn/ Folders"
			if (mode === 'local') {
				const localFiles = await fetchFromLocalDirectoryListing();
				if (localFiles && localFiles.length > 0) {
					setDiscoveryStatus('Local /cdn/ Folders (Live)', true);
					processDiscoveredFiles(localFiles);
					return;
				}
				setDiscoveryStatus('Local Scan Empty (Use Live Server)', false);
				processDiscoveredFiles([]);
				return;
			}

			// Mode 2: User forced "Azure Blob Live XML"
			if (mode === 'azure') {
				const azureFiles = await fetchFromAzureBlobXml(state.baseUrl);
				if (azureFiles && azureFiles.length > 0) {
					setDiscoveryStatus('Azure Blob XML (Live)', true);
					processDiscoveredFiles(azureFiles);
					return;
				}
			}

			// Mode 3: "Auto (Smart Detect)" on localhost -> try local folders first
			if (mode === 'auto' && isLocalhost) {
				const localFiles = await fetchFromLocalDirectoryListing();
				if (localFiles && localFiles.length > 0) {
					setDiscoveryStatus('Local /cdn/ Folders (Live)', true);
					processDiscoveredFiles(localFiles);
					return;
				}
			}

			// Mode 4: Default Production path -> query Azure Blob Storage XML API
			const azureFiles = await fetchFromAzureBlobXml(state.baseUrl);
			if (azureFiles && azureFiles.length > 0) {
				setDiscoveryStatus('Azure Blob XML (Live)', true);
				processDiscoveredFiles(azureFiles);
				return;
			}

			// Fallback if Azure XML returned nothing (e.g., offline local server)
			const localFiles = await fetchFromLocalDirectoryListing();
			if (localFiles && localFiles.length > 0) {
				setDiscoveryStatus('Local /cdn/ Folders (Live)', true);
				processDiscoveredFiles(localFiles);
				return;
			}

			// If both tiers returned zero files, show the empty state
			setDiscoveryStatus('No CDN Assets Found', false);
			processDiscoveredFiles([]);
		} catch (err) {
			console.warn('Asset discovery encountered an error:', err);
			setDiscoveryStatus('Discovery Error', false);
			processDiscoveredFiles([]);
		} finally {
			setLoading(false);
		}
	}

	/**
	 * TIER 1: Queries Azure Blob Storage's public XML container listing API.
	 *
	 * Endpoint format:
	 *   `{containerUrl}?restype=container&comp=list`
	 *
	 * Supports Azure's `<NextMarker>` pagination in case the container ever grows
	 * past 5,000 blobs, and filters solely for files matching `/css/cdn/`, `/js/cdn/`,
	 * or `/img/cdn/`.
	 *
	 * @param {string} containerUrl - Base URL of the Azure Blob container
	 * @returns {Promise<Array|null>} Array of file metadata objects, or null on failure
	 */
	async function fetchFromAzureBlobXml(containerUrl) {
		try {
			const cleanBase = containerUrl.replace(/\/+$/, '');
			const discovered = [];
			let marker = '';

			// Loop through pages until Azure returns an empty <NextMarker>
			do {
				const listUrl =
					`${cleanBase}?restype=container&comp=list` +
					(marker ? `&marker=${encodeURIComponent(marker)}` : '');

				const response = await fetch(listUrl, { method: 'GET', mode: 'cors', cache: 'no-store' });
				if (!response.ok) return null;

				const xmlText = await response.text();
				const parser = new DOMParser();
				const xmlDoc = parser.parseFromString(xmlText, 'application/xml');

				// Abort if response is not valid XML
				if (xmlDoc.querySelector('parsererror')) return null;

				const blobs = xmlDoc.querySelectorAll('Blobs > Blob');
				blobs.forEach((blobNode) => {
					const nameNode = blobNode.querySelector('Name');
					if (!nameNode) return;

					const relativePath = nameNode.textContent.trim().replace(/^\/+/, '');
					if (!parseCdnAssetPath(relativePath)) return;

					const sizeNode = blobNode.querySelector('Properties > Content-Length');
					const lastModNode = blobNode.querySelector('Properties > Last-Modified');

					discovered.push({
						path: relativePath,
						size: sizeNode ? parseInt(sizeNode.textContent, 10) : null,
						lastModified: lastModNode ? lastModNode.textContent.trim() : null
					});
				});

				const nextMarkerNode = xmlDoc.querySelector('NextMarker');
				marker = nextMarkerNode && nextMarkerNode.textContent ? nextMarkerNode.textContent.trim() : '';
			} while (marker);

			return discovered;
		} catch (e) {
			return null;
		}
	}

	/**
	 * TIER 2: Crawls local `/css/cdn/`, `/js/cdn/`, and `/img/cdn/` directory listings
	 * when running a local development web server (e.g., VS Code Live Server,
	 * Python `http.server`, or `npx serve`).
	 *
	 * Note: Browsers do not allow `fetch()` to list folders over `file://`,
	 * so this function returns `null` immediately if opened via `file://`.
	 *
	 * @returns {Promise<Array|null>} Array of discovered file objects, or null
	 */
	async function fetchFromLocalDirectoryListing() {
		if (window.location.protocol === 'file:') return null;

		try {
			const roots = ['css/cdn/', 'js/cdn/', 'img/cdn/'];
			const discovered = [];

			/**
			 * Recursive helper that fetches an HTML directory listing page,
			 * extracts all `<a href="...">` links, and either records matching
			 * asset files or drills down into subfolders.
			 *
			 * @param {string} dirPath - Current relative directory path (always ends with `/`)
			 * @param {number} depth   - Current recursion depth (capped at 4 to prevent infinite loops)
			 */
			async function crawlDirectory(dirPath, depth) {
				if (depth > 4) return;
				const res = await fetch(dirPath, { cache: 'no-store' });
				if (!res.ok) return;

				const contentType = res.headers.get('content-type') || '';
				if (!contentType.includes('text/html')) return;

				const html = await res.text();
				const doc = new DOMParser().parseFromString(html, 'text/html');
				const anchors = Array.from(doc.querySelectorAll('a[href]'));

				for (const a of anchors) {
					const rawHref = a.getAttribute('href');
					if (
						!rawHref ||
						rawHref.startsWith('?') ||
						rawHref.startsWith('#') ||
						rawHref === '../' ||
						rawHref === '/'
					) {
						continue;
					}

					// Resolve the link against the current directory URL
					const resolvedUrl = new URL(rawHref, new URL(dirPath, window.location.href));
					const basePath = window.location.pathname.replace(/\/index\.html$/i, '/').replace(/\/+$/, '/');
					if (!resolvedUrl.pathname.startsWith(basePath)) continue;

					const rel = decodeURIComponent(resolvedUrl.pathname.slice(basePath.length)).replace(/^\/+/, '');
					if (!rel || rel === dirPath || !dirPath.startsWith(rel.split('/')[0])) continue;

					/**
					 * IMPORTANT FIX FOR VERSION FOLDERS (e.g., `4.1`, `5.3`, `5.3.2`):
					 * Dev servers like VS Code Live Server often omit the trailing `/`
					 * on directory links (`href="/css/cdn/font-awesome/4.1"`).
					 * Because version numbers contain a dot (`.`), a naive filename check
					 * would mistake `4.1` for a file extension and skip crawling inside it!
					 *
					 * Instead, we explicitly check if the link ends with a real asset file
					 * extension (`.js`, `.css`, `.png`, `.svg`, etc.). If not, we treat it as a subfolder.
					 */
					const isKnownAssetFile = /\.(css|js|map|png|jpe?g|svg|gif|webp|avif|ico|woff2?|ttf|eot|json|txt|md)$/i.test(rel);

					if (rawHref.endsWith('/') || !isKnownAssetFile) {
						const nextDir = rel.endsWith('/') ? rel : rel + '/';
						if (nextDir.startsWith(dirPath) && nextDir !== dirPath) {
							await crawlDirectory(nextDir, depth + 1);
						}
					} else if (parseCdnAssetPath(rel)) {
						discovered.push({ path: rel, size: null, lastModified: null });
					}
				}
			}

			for (const root of roots) {
				await crawlDirectory(root, 0);
			}

			return discovered.length > 0 ? discovered : null;
		} catch (e) {
			return null;
		}
	}

	/* ==========================================================================
	   7. DATA NORMALIZATION, GROUPING & VERSION SORTING
	   ========================================================================== */

	/**
	 * Takes the flat list of discovered file paths (`css/cdn/...`, `js/cdn/...`, `img/cdn/...`),
	 * groups them into libraries and versions, matches images against the predefined
	 * `images` metadata array, sorts them (newest version first), and triggers a UI render.
	 *
	 * @param {Array<{path: string, size: number|null, lastModified: string|null}>} rawFiles
	 */
	function processDiscoveredFiles(rawFiles) {
		const libraryMap = new Map();

		rawFiles.forEach((item) => {
			const rawPath = typeof item === 'string' ? item : item.path;
			const parsed = parseCdnAssetPath(rawPath);
			if (!parsed) return;

			const { type, library, version, fileName, relativePath } = parsed;
			const key = `${type}:${library.toLowerCase()}`;

			if (!libraryMap.has(key)) {
				libraryMap.set(key, {
					key,
					type,
					slug: library,
					displayName: formatLibraryDisplayName(library),
					versionsMap: new Map()
				});
			}

			const libEntry = libraryMap.get(key);
			if (!libEntry.versionsMap.has(version)) {
				libEntry.versionsMap.set(version, []);
			}

			// Look up predefined alt and figcaption metadata for image assets
			const predefinedMeta =
				type === 'img' ? findPredefinedImageMeta(relativePath, fileName) : null;

			// Prevent duplicate file entries inside the same version
			const existingFiles = libEntry.versionsMap.get(version);
			if (!existingFiles.some((f) => f.relativePath === relativePath)) {
				existingFiles.push({
					fileName,
					version,
					relativePath,
					size: item.size || null,
					lastModified: item.lastModified || null,
					predefinedAlt: predefinedMeta ? predefinedMeta.alt : '',
					predefinedFigcaption: predefinedMeta ? predefinedMeta.figcaption : '',
					hasPredefinedMatch: Boolean(predefinedMeta)
				});
			}
		});

		// Convert the Map into a sorted array of Library objects
		const libraries = [];
		libraryMap.forEach((lib) => {
			// Sort versions descending using semantic version comparison (e.g. 5.3 > 4.1)
			const sortedVersions = Array.from(lib.versionsMap.keys()).sort((a, b) =>
				compareSemverDesc(a, b)
			);

			const versions = sortedVersions.map((ver) => {
				const files = lib.versionsMap.get(ver).sort((a, b) => a.fileName.localeCompare(b.fileName));
				return {
					version: ver,
					files
				};
			});

			libraries.push({
				key: lib.key,
				type: lib.type,
				slug: lib.slug,
				displayName: lib.displayName,
				latestVersion: sortedVersions[0] || '',
				versions
			});
		});

		// Sort library cards alphabetically by their display name
		libraries.sort((a, b) => a.displayName.localeCompare(b.displayName));

		state.libraries = libraries;
		updateCategoryCounts();
		renderAssetsGrid();
	}

	/**
	 * Converts a folder slug (like `'font-awesome'` or `'logos'`) into a clean,
	 * human-friendly card title (like `'Font Awesome'` or `'Logos'`).
	 *
	 * @param {string} slug - Folder name inside `/css/cdn/`, `/js/cdn/`, or `/img/cdn/`
	 * @returns {string} Formatted display title
	 */
	function formatLibraryDisplayName(slug) {
		const knownNames = {
			'jquery': 'jQuery',
			'font-awesome': 'Font Awesome',
			'bootstrap': 'Bootstrap',
			'popper': 'Popper.js',
			'lodash': 'Lodash',
			'moment': 'Moment.js',
			'axios': 'Axios',
			'chartjs': 'Chart.js',
			'datatables': 'DataTables',
			'select2': 'Select2',
			'logos': 'JHM Logos & Brand Marks',
			'icons': 'Icons & UI Graphics',
			'banners': 'Hero & Page Banners'
		};

		const lower = slug.toLowerCase();
		if (knownNames[lower]) return knownNames[lower];

		// Default: split on hyphens/underscores and capitalize each word
		return slug
			.split(/[-_]+/)
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(' ');
	}

	/**
	 * Compares two version strings in descending order (newest first).
	 * Example: `'5.3'` comes before `'4.1'`.
	 */
	function compareSemverDesc(a, b) {
		const partsA = String(a).replace(/^v/i, '').split(/[.-]/);
		const partsB = String(b).replace(/^v/i, '').split(/[.-]/);
		const len = Math.max(partsA.length, partsB.length);

		for (let i = 0; i < len; i++) {
			const numA = parseInt(partsA[i], 10);
			const numB = parseInt(partsB[i], 10);

			if (!isNaN(numA) && !isNaN(numB)) {
				if (numA !== numB) return numB - numA;
			} else {
				const strA = partsA[i] || '';
				const strB = partsB[i] || '';
				if (strA !== strB) return strB.localeCompare(strA);
			}
		}
		return 0;
	}

	/* ==========================================================================
	   8. UI RENDERING & FILTERING
	   ========================================================================== */

	/**
	 * Updates the badge counters on the "All Assets", "JavaScript", "Stylesheets",
	 * and "Images" filter buttons in the hero toolbar.
	 */
	function updateCategoryCounts() {
		let totalFiles = 0;
		let jsFiles = 0;
		let cssFiles = 0;
		let imgFiles = 0;

		state.libraries.forEach((lib) => {
			lib.versions.forEach((verObj) => {
				const count = verObj.files.length;
				totalFiles += count;
				if (lib.type === 'js') jsFiles += count;
				if (lib.type === 'css') cssFiles += count;
				if (lib.type === 'img') imgFiles += count;
			});
		});

		dom.countAll.textContent = totalFiles;
		dom.countJs.textContent = jsFiles;
		dom.countCss.textContent = cssFiles;
		if (dom.countImg) dom.countImg.textContent = imgFiles;
	}

	/**
	 * Filters `state.libraries` based on the active category tab and search query,
	 * then builds and injects the HTML cards into `#assetsGrid`.
	 */
	function renderAssetsGrid() {
		const query = state.searchQuery.trim().toLowerCase();
		const category = state.filterCategory;

		const filteredLibraries = [];

		state.libraries.forEach((lib) => {
			// 1. Filter by Category Tab ('all', 'js', 'css', or 'img')
			if (category !== 'all' && lib.type !== category) return;

			// 2. Check which version is selected for this library card ('all' by default)
			const selectedVer = state.selectedVersions[lib.key] || 'all';

			// 3. Filter versions & files by the search query (supports multi-word searches like "jquery 5.3")
			const matchingVersions = [];

			lib.versions.forEach((verObj) => {
				if (selectedVer !== 'all' && verObj.version !== selectedVer) return;

				const matchingFiles = verObj.files.filter((file) => {
					if (!query) return true;
					const haystack = `${lib.displayName} ${lib.slug} ${lib.type} ${verObj.version} ${file.fileName} ${file.relativePath} ${file.predefinedAlt} ${file.predefinedFigcaption}`.toLowerCase();
					const tokens = query.split(/\s+/);
					return tokens.every((token) => haystack.includes(token));
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

		// Toggle Empty State if no results match
		if (filteredLibraries.length === 0) {
			dom.assetsGrid.innerHTML = '';
			dom.emptyState.classList.remove('hidden');
			return;
		}

		dom.emptyState.classList.add('hidden');
		dom.assetsGrid.innerHTML = filteredLibraries.map((lib) => buildLibraryCardHtml(lib)).join('');
	}

	/**
	 * Generates the HTML string for a single Library Card (header, version selector,
	 * and list of file rows with action buttons).
	 */
	function buildLibraryCardHtml(lib) {
		const selectedVer = state.selectedVersions[lib.key] || 'all';
		const typeLabel = lib.type === 'js' ? 'JS' : lib.type === 'css' ? 'CSS' : 'IMG';
		const typeClass = lib.type === 'js' ? 'type-js' : lib.type === 'css' ? 'type-css' : 'type-img';

		// Hide version dropdown if an image folder only uses the flat 'latest' structure
		const hasMultipleOrNamedVersions =
			lib.versions.length > 1 ||
			(lib.versions.length === 1 && lib.versions[0].version !== 'latest');

		// Build options for the card's Version dropdown
		const versionOptionsHtml = [
			`<option value="all" ${selectedVer === 'all' ? 'selected' : ''}>All Versions (${lib.versions.length})</option>`,
			...lib.versions.map((v) => {
				const isLatest = v.version === lib.latestVersion && lib.versions.length > 1;
				const label = `v${v.version}${isLatest ? ' (Latest)' : ''}`;
				return `<option value="${escapeAttr(v.version)}" ${selectedVer === v.version ? 'selected' : ''}>${escapeHtml(label)}</option>`;
			})
		].join('');

		// Build each file row inside the card
		const rowsHtml = lib.matchingVersions
			.map((verObj) =>
				verObj.files
					.map((file) => {
						const fullUrl = buildFullAssetUrl(file.relativePath);
						const sizeBadge = file.size ? ` &bull; ${formatBytes(file.size)}` : '';
						const isImage = lib.type === 'img';

						// Version badge (for flat images where version === 'latest', show 'CDN IMAGE')
						const versionPillLabel =
							isImage && verObj.version === 'latest'
								? 'IMAGE'
								: `v${verObj.version}`;

						// Thumbnail preview for image rows
						const thumbnailHtml = isImage
							? `<div class="file-thumb-box" aria-hidden="true">
									<img src="${escapeAttr(fullUrl)}" alt="" class="file-thumb-img" loading="lazy">
							   </div>`
							: '';

						// Display predefined alt summary on image rows so users see the approved metadata immediately
						const predefinedMetaSummaryHtml = isImage
							? file.hasPredefinedMatch
								? `<span class="file-meta-sub">Predefined <code>alt</code>: &ldquo;${escapeHtml(file.predefinedAlt)}&rdquo;</span>`
								: `<span class="file-meta-sub" style="color: #fbbf24;">Note: Add this image to the <code>images[]</code> array in <code>js/site.js</code></span>`
							: '';

						// Primary HTML tag action button:
						// - For JS/CSS: immediate "Copy <script>" or "Copy <link>"
						// - For Images: "Generate Tag" button that opens the modal pre-populated with `images[]` metadata
						let primaryTagActionButtonHtml = '';
						if (isImage) {
							primaryTagActionButtonHtml = `
								<button
									type="button"
									class="btn-action btn-generate-tag"
									data-open-img-modal="true"
									data-img-url="${escapeAttr(fullUrl)}"
									data-img-name="${escapeAttr(file.fileName)}"
									data-img-alt="${escapeAttr(file.predefinedAlt)}"
									data-img-figcaption="${escapeAttr(file.predefinedFigcaption)}"
									data-img-has-meta="${file.hasPredefinedMatch ? 'true' : 'false'}"
									title="Open modal to generate <img> or <figure> HTML tag with predefined metadata"
								>
									<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
										<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
										<circle cx="8.5" cy="8.5" r="1.5"></circle>
										<polyline points="21 15 16 10 5 21"></polyline>
									</svg>
									Generate Tag
								</button>`;
						} else {
							const htmlSnippet = buildHtmlSnippet(lib.type, fullUrl);
							const snippetBtnLabel = lib.type === 'js' ? 'Copy <script>' : 'Copy <link>';
							primaryTagActionButtonHtml = `
								<button
									type="button"
									class="btn-action"
									data-copy="${escapeAttr(htmlSnippet)}"
									data-label="HTML Tag"
									title="Copy ready-to-use HTML tag"
								>
									<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
										<polyline points="16 18 22 12 16 6"></polyline>
										<polyline points="8 6 2 12 8 18"></polyline>
									</svg>
									${escapeHtml(snippetBtnLabel)}
								</button>`;
						}

						return `
						<div class="file-row">
							<div class="file-info">
								${thumbnailHtml}
								<span class="version-pill">${escapeHtml(versionPillLabel)}</span>
								<div class="file-path-box">
									<span class="file-name">${escapeHtml(file.fileName)}</span>
									<span class="file-url">${escapeHtml(fullUrl)}${sizeBadge}</span>
									${predefinedMetaSummaryHtml}
								</div>
							</div>
							<div class="file-actions">
								<button
									type="button"
									class="btn-action"
									data-copy="${escapeAttr(fullUrl)}"
									data-label="URL"
									title="Copy direct CDN URL"
								>
									<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
										<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
										<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
									</svg>
									Copy URL
								</button>
								${primaryTagActionButtonHtml}
								<a
									href="${escapeAttr(fullUrl)}"
									target="_blank"
									rel="noopener"
									class="btn-action"
									aria-label="Open raw file ${escapeAttr(file.fileName)} in a new tab"
									title="Open raw file in new tab"
								>
									<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
										<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
										<polyline points="15 3 21 3 21 9"></polyline>
										<line x1="10" y1="14" x2="21" y2="3"></line>
									</svg>
								</a>
							</div>
						</div>`;
					})
					.join('')
			)
			.join('');

		const folderSubtitle =
			lib.type === 'img' && lib.slug === 'general'
				? '/img/cdn/'
				: `/${lib.type}/cdn/${lib.slug}/`;

		const versionControlsHtml = hasMultipleOrNamedVersions
			? `<div class="card-controls">
					<label class="version-label" for="ver-${escapeAttr(lib.key)}">Version:</label>
					<select
						id="ver-${escapeAttr(lib.key)}"
						class="version-select"
						data-lib-key="${escapeAttr(lib.key)}"
					>
						${versionOptionsHtml}
					</select>
			   </div>`
			: '';

		return `
		<article class="library-card" data-lib-key="${escapeAttr(lib.key)}">
			<div class="card-header">
				<div class="library-title-group">
					<span class="type-badge ${typeClass}">${typeLabel}</span>
					<h3 class="library-name">${escapeHtml(lib.displayName)}</h3>
					<span class="library-folder">${escapeHtml(folderSubtitle)}</span>
				</div>
				${versionControlsHtml}
			</div>
			<div class="file-list">
				${rowsHtml}
			</div>
		</article>`;
	}

	/* ==========================================================================
	   9. IMAGE TAG GENERATOR MODAL LOGIC (PREDEFINED METADATA ARRAY EDITION)
	   ========================================================================== */

	/**
	 * Opens the "Generate Image HTML Tag" modal for a selected CDN image asset,
	 * automatically pre-populating the `alt` and `figcaption` inputs from the
	 * `images` array.
	 *
	 * @param {object} params
	 * @param {string} params.fileUrl           - Full CDN URL to the image
	 * @param {string} params.fileName          - File name (e.g. `jhm-logo.png`)
	 * @param {string} params.predefinedAlt     - Predefined `alt` text from `images[]`
	 * @param {string} params.predefinedCaption - Predefined `figcaption` text from `images[]`
	 * @param {boolean} params.hasPredefined    - Whether the image was found in `images[]`
	 * @param {HTMLElement} params.triggerEl    - Button element that triggered the modal
	 */
	function openImageTagModal({
		fileUrl,
		fileName,
		predefinedAlt,
		predefinedCaption,
		hasPredefined,
		triggerEl
	}) {
		if (!dom.imgTagModalBackdrop) return;

		state.modal.isOpen = true;
		state.modal.mode = 'img';
		state.modal.fileUrl = fileUrl;
		state.modal.fileName = fileName;
		state.modal.predefinedAlt = predefinedAlt || '';
		state.modal.predefinedFigcaption = predefinedCaption || '';
		state.modal.hasPredefinedMatch = Boolean(hasPredefined);
		state.modal.isUnlockedForCustomEdit = !hasPredefined;
		state.modal.lastFocusedElement = triggerEl || document.activeElement;

		// Populate image preview bar
		dom.modalImgPreview.src = fileUrl;
		dom.modalImgPreview.alt = `Preview of ${fileName}`;
		dom.modalImgName.textContent = fileName;
		dom.modalImgUrl.textContent = fileUrl;

		// Update predefined status badge
		if (dom.modalPredefinedBadge) {
			if (hasPredefined) {
				dom.modalPredefinedBadge.textContent = 'Predefined Metadata Loaded';
				dom.modalPredefinedBadge.className = 'predefined-badge predefined-badge-ok';
			} else {
				dom.modalPredefinedBadge.textContent = 'Not Found in images[] Array';
				dom.modalPredefinedBadge.className = 'predefined-badge predefined-badge-warn';
			}
		}

		// Pre-populate inputs with predefined values from the `images` array
		dom.modalAltInput.value = state.modal.predefinedAlt;
		dom.modalCaptionInput.value = state.modal.predefinedFigcaption;

		// Apply read-only lock state (locked by default when predefined metadata exists)
		syncModalReadonlyLockUI();

		// Set initial mode to "<img> tag only" and render the pre-populated HTML tag preview
		setModalTagMode('img');

		// Show modal
		dom.imgTagModalBackdrop.classList.remove('hidden');
		dom.imgTagModalBackdrop.setAttribute('aria-hidden', 'false');

		// Focus the primary format toggle button or Copy button for quick keyboard use
		setTimeout(() => {
			if (dom.modeImgOnlyBtn) dom.modeImgOnlyBtn.focus();
		}, 20);
	}

	/**
	 * Synchronizes the read-only vs. unlocked state of the Alt and Figcaption inputs.
	 */
	function syncModalReadonlyLockUI() {
		const isUnlocked = state.modal.isUnlockedForCustomEdit;

		if (dom.modalAltInput) {
			dom.modalAltInput.readOnly = !isUnlocked;
			dom.modalAltInput.classList.toggle('is-readonly', !isUnlocked);
		}
		if (dom.modalCaptionInput) {
			dom.modalCaptionInput.readOnly = !isUnlocked;
			dom.modalCaptionInput.classList.toggle('is-readonly', !isUnlocked);
		}

		if (dom.toggleEditPredefinedBtn) {
			dom.toggleEditPredefinedBtn.setAttribute('aria-pressed', isUnlocked ? 'true' : 'false');
			dom.toggleEditPredefinedBtn.classList.toggle('unlocked', isUnlocked);
			dom.toggleEditPredefinedBtn.textContent = isUnlocked
				? 'Reset to Predefined'
				: 'Unlock to Customize';
		}

		if (dom.modalLockStatusText) {
			if (!state.modal.hasPredefinedMatch) {
				dom.modalLockStatusText.innerHTML =
					'No entry in <code>images[]</code> array &mdash; custom input enabled';
			} else if (isUnlocked) {
				dom.modalLockStatusText.innerHTML =
					'Custom override active (click <strong>Reset to Predefined</strong> to restore)';
			} else {
				dom.modalLockStatusText.innerHTML =
					'Using predefined values from <code>images[]</code> array';
			}
		}
	}

	/**
	 * Toggles between locked predefined metadata (`images[]`) and custom editing.
	 * When locking back ("Reset to Predefined"), restores the official predefined
	 * `alt` and `figcaption` strings from `images[]`.
	 */
	function toggleModalPredefinedLock() {
		state.modal.isUnlockedForCustomEdit = !state.modal.isUnlockedForCustomEdit;

		if (!state.modal.isUnlockedForCustomEdit) {
			// Restore official predefined values from `images[]`
			dom.modalAltInput.value = state.modal.predefinedAlt;
			dom.modalCaptionInput.value = state.modal.predefinedFigcaption;
		} else {
			dom.modalAltInput.focus();
		}

		syncModalReadonlyLockUI();
		updateModalLivePreview();
	}

	/**
	 * Closes the "Generate Image HTML Tag" modal and restores keyboard focus
	 * to the button that opened it.
	 */
	function closeImageTagModal() {
		if (!dom.imgTagModalBackdrop || !state.modal.isOpen) return;

		state.modal.isOpen = false;
		dom.imgTagModalBackdrop.classList.add('hidden');
		dom.imgTagModalBackdrop.setAttribute('aria-hidden', 'true');

		if (state.modal.lastFocusedElement && typeof state.modal.lastFocusedElement.focus === 'function') {
			state.modal.lastFocusedElement.focus();
		}
	}

	/**
	 * Switches the modal between:
	 *   - `'img'`: `<img>` tag only
	 *   - `'figure'`: `<img>` with `<figure>` and `<figcaption>`
	 *
	 * @param {'img' | 'figure'} mode
	 */
	function setModalTagMode(mode) {
		state.modal.mode = mode === 'figure' ? 'figure' : 'img';
		const isFigure = state.modal.mode === 'figure';

		// Update toggle button states
		if (dom.modeImgOnlyBtn && dom.modeFigureBtn) {
			dom.modeImgOnlyBtn.classList.toggle('active', !isFigure);
			dom.modeImgOnlyBtn.setAttribute('aria-pressed', !isFigure ? 'true' : 'false');

			dom.modeFigureBtn.classList.toggle('active', isFigure);
			dom.modeFigureBtn.setAttribute('aria-pressed', isFigure ? 'true' : 'false');
		}

		// Show or hide the <figcaption> input field
		if (dom.modalCaptionGroup) {
			dom.modalCaptionGroup.classList.toggle('hidden', !isFigure);
		}

		updateModalLivePreview();
	}

	/**
	 * Builds the live HTML snippet for the modal based on the current mode,
	 * `alt` text input, and `figcaption` text input.
	 *
	 * @returns {string} Ready-to-copy HTML snippet
	 */
	function buildModalImageHtmlSnippet() {
		const url = state.modal.fileUrl;
		const altText = dom.modalAltInput ? dom.modalAltInput.value : '';
		const captionText = dom.modalCaptionInput ? dom.modalCaptionInput.value : '';

		const imgTag = `<img src="${escapeAttr(url)}" alt="${escapeAttr(altText)}" loading="lazy">`;

		if (state.modal.mode === 'figure') {
			return `<figure>\n  ${imgTag}\n  <figcaption>${escapeHtml(captionText)}</figcaption>\n</figure>`;
		}

		return imgTag;
	}

	/**
	 * Updates the `<code id="modalCodeOutput">` preview box in real time.
	 */
	function updateModalLivePreview() {
		if (!dom.modalCodeOutput) return;
		dom.modalCodeOutput.textContent = buildModalImageHtmlSnippet();
	}

	/* ==========================================================================
	   10. URL & HTML SNIPPET HELPERS
	   ========================================================================== */

	/**
	 * Combines the current `state.baseUrl` with a file's relative path to form
	 * a complete URL.
	 */
	function buildFullAssetUrl(relativePath) {
		const cleanBase = (state.baseUrl || DEFAULT_AZURE_CONTAINER_URL).replace(/\/+$/, '');
		const cleanRel = String(relativePath).replace(/^\/+/, '');
		return `${cleanBase}/${cleanRel}`;
	}

	/**
	 * Wraps a full asset URL in the appropriate HTML tag (`<script>` or `<link>`).
	 */
	function buildHtmlSnippet(type, fullUrl) {
		if (type === 'js') {
			return `<script src="${fullUrl}"></script>`;
		}
		return `<link rel="stylesheet" href="${fullUrl}">`;
	}

	/**
	 * Copies text to the user's clipboard, temporarily turns the clicked button
	 * green ("Copied!"), and shows a toast notification at the bottom right.
	 */
	async function copyToClipboard(text, label, buttonEl) {
		try {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(text);
			} else {
				// Fallback for older browsers
				const textarea = document.createElement('textarea');
				textarea.value = text;
				textarea.style.position = 'fixed';
				textarea.style.opacity = '0';
				document.body.appendChild(textarea);
				textarea.select();
				document.execCommand('copy');
				document.body.removeChild(textarea);
			}

			if (buttonEl) {
				const originalHtml = buttonEl.innerHTML;
				buttonEl.classList.add('copied');
				buttonEl.innerHTML = `
					<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none">
						<polyline points="20 6 9 17 4 12"></polyline>
					</svg>
					Copied!`;
				setTimeout(() => {
					buttonEl.classList.remove('copied');
					buttonEl.innerHTML = originalHtml;
				}, 1400);
			}

			showToast(`${label} copied to clipboard!`);
		} catch (err) {
			showToast('Unable to copy automatically. Please copy manually.');
		}
	}

	/* ==========================================================================
	   11. UI STATUS, TOAST & ESCAPING UTILITIES
	   ========================================================================== */

	function setLoading(isLoading) {
		if (isLoading) {
			dom.loadingState.classList.remove('hidden');
			dom.assetsGrid.classList.add('hidden');
			dom.emptyState.classList.add('hidden');
		} else {
			dom.loadingState.classList.add('hidden');
			dom.assetsGrid.classList.remove('hidden');
		}
	}

	function setDiscoveryStatus(text, isOnline) {
		dom.statusText.textContent = text;
		if (isOnline) {
			dom.statusDot.classList.add('online');
		} else {
			dom.statusDot.classList.remove('online');
		}
	}

	let toastTimer = null;
	function showToast(message) {
		dom.toast.textContent = message;
		dom.toast.classList.add('show');
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => {
			dom.toast.classList.remove('show');
		}, 2400);
	}

	function formatBytes(bytes) {
		if (!bytes || isNaN(bytes)) return '';
		if (bytes < 1024) return `${bytes} B`;
		const kb = bytes / 1024;
		if (kb < 1024) return `${kb.toFixed(1)} KB`;
		return `${(kb / 1024).toFixed(2)} MB`;
	}

	function escapeHtml(str) {
		return String(str)
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	}

	function escapeAttr(str) {
		return escapeHtml(str);
	}

	/* ==========================================================================
	   12. BASE URL INITIALIZATION & EVENT LISTENERS
	   ========================================================================== */

	/**
	 * Initializes the Base URL input box on startup:
	 *   - On `localhost` / `127.0.0.1`: Uses the local dev server URL so clicking
	 *     "Open Raw File" or "Copy URL" points to the local files being tested.
	 *   - On `*.blob.core.windows.net`: Automatically derives the container URL.
	 *   - Everywhere else: Defaults to `https://jhmcdn.blob.core.windows.net/global-assets`.
	 */
	function initBaseUrl() {
		const host = window.location.hostname;
		const isLocalhost = host === 'localhost' || host === '127.0.0.1';

		if (isLocalhost) {
			const cleanPath = window.location.pathname
				.replace(/\/index\.html$/i, '')
				.replace(/\/+$/, '');
			state.baseUrl = `${window.location.origin}${cleanPath}`;
		} else if (host.endsWith('.blob.core.windows.net')) {
			const pathParts = window.location.pathname.split('/').filter(Boolean);
			const container = pathParts.length > 0 ? `/${pathParts[0]}` : '';
			state.baseUrl = `${window.location.origin}${container}`;
		} else {
			state.baseUrl = DEFAULT_AZURE_CONTAINER_URL;
		}
		dom.baseUrlInput.value = state.baseUrl;
	}

	/**
	 * Attaches all user interaction event listeners (search input, keyboard
	 * shortcuts, category filter tabs, source selector, version dropdowns,
	 * copy buttons, and the Generate Image HTML Tag modal).
	 */
	function bindEvents() {
		// Live search input
		dom.searchInput.addEventListener('input', (e) => {
			state.searchQuery = e.target.value;
			renderAssetsGrid();
		});

		// Global keyboard shortcuts: `/` focuses search, `Escape` closes modal or clears search
		document.addEventListener('keydown', (e) => {
			if (state.modal.isOpen) {
				if (e.key === 'Escape') {
					e.preventDefault();
					closeImageTagModal();
				}
				return;
			}

			if (e.key === '/' && document.activeElement !== dom.searchInput && document.activeElement !== dom.baseUrlInput) {
				e.preventDefault();
				dom.searchInput.focus();
			} else if (e.key === 'Escape' && document.activeElement === dom.searchInput) {
				dom.searchInput.value = '';
				state.searchQuery = '';
				renderAssetsGrid();
				dom.searchInput.blur();
			}
		});

		// Category filter tabs (All / JavaScript / Stylesheets / Images)
		dom.filterTabs.forEach((tab) => {
			tab.addEventListener('click', () => {
				dom.filterTabs.forEach((t) => {
					t.classList.remove('active');
					t.setAttribute('aria-pressed', 'false');
				});
				tab.classList.add('active');
				tab.setAttribute('aria-pressed', 'true');
				state.filterCategory = tab.getAttribute('data-filter') || 'all';
				renderAssetsGrid();
			});
		});

		// Base URL manual override
		dom.baseUrlInput.addEventListener('change', () => {
			state.baseUrl = dom.baseUrlInput.value.trim() || DEFAULT_AZURE_CONTAINER_URL;
			renderAssetsGrid();
		});

		// Source Mode dropdown change
		if (dom.sourceModeSelect) {
			dom.sourceModeSelect.addEventListener('change', () => {
				discoverAssets();
			});
		}

		// Sync / Refresh button
		dom.refreshBtn.addEventListener('click', () => {
			state.baseUrl = dom.baseUrlInput.value.trim() || DEFAULT_AZURE_CONTAINER_URL;
			discoverAssets();
		});

		// Reset search & filters button (shown in Empty State)
		dom.resetSearchBtn.addEventListener('click', () => {
			state.searchQuery = '';
			state.filterCategory = 'all';
			state.selectedVersions = {};
			dom.searchInput.value = '';
			dom.filterTabs.forEach((t) => {
				const isAll = t.getAttribute('data-filter') === 'all';
				t.classList.toggle('active', isAll);
				t.setAttribute('aria-pressed', isAll ? 'true' : 'false');
			});
			renderAssetsGrid();
		});

		// Delegated listener for per-card Version `<select>` dropdowns
		dom.assetsGrid.addEventListener('change', (e) => {
			const selectEl = e.target.closest('.version-select');
			if (!selectEl) return;
			const libKey = selectEl.getAttribute('data-lib-key');
			state.selectedVersions[libKey] = selectEl.value;
			renderAssetsGrid();
		});

		// Delegated listener for Copy buttons AND "Generate Tag" modal trigger buttons
		dom.assetsGrid.addEventListener('click', (e) => {
			const modalTriggerBtn = e.target.closest('button[data-open-img-modal]');
			if (modalTriggerBtn) {
				openImageTagModal({
					fileUrl: modalTriggerBtn.getAttribute('data-img-url') || '',
					fileName: modalTriggerBtn.getAttribute('data-img-name') || '',
					predefinedAlt: modalTriggerBtn.getAttribute('data-img-alt') || '',
					predefinedCaption: modalTriggerBtn.getAttribute('data-img-figcaption') || '',
					hasPredefined: modalTriggerBtn.getAttribute('data-img-has-meta') === 'true',
					triggerEl: modalTriggerBtn
				});
				return;
			}

			const copyBtn = e.target.closest('button[data-copy]');
			if (!copyBtn) return;
			const textToCopy = copyBtn.getAttribute('data-copy');
			const label = copyBtn.getAttribute('data-label') || 'Snippet';
			copyToClipboard(textToCopy, label, copyBtn);
		});

		// Modal Event Listeners
		if (dom.imgTagModalBackdrop) {
			// Toggle between `<img> tag only` and `<img> with <figure> and <figcaption>`
			if (dom.modeImgOnlyBtn) {
				dom.modeImgOnlyBtn.addEventListener('click', () => setModalTagMode('img'));
			}
			if (dom.modeFigureBtn) {
				dom.modeFigureBtn.addEventListener('click', () => setModalTagMode('figure'));
			}

			// Toggle Lock / Unlock to customize predefined metadata
			if (dom.toggleEditPredefinedBtn) {
				dom.toggleEditPredefinedBtn.addEventListener('click', toggleModalPredefinedLock);
			}

			// Real-time live preview updates if user unlocks and edits Alt or Figcaption fields
			if (dom.modalAltInput) {
				dom.modalAltInput.addEventListener('input', updateModalLivePreview);
			}
			if (dom.modalCaptionInput) {
				dom.modalCaptionInput.addEventListener('input', updateModalLivePreview);
			}

			// Close modal buttons & backdrop click
			if (dom.closeImgModalBtn) {
				dom.closeImgModalBtn.addEventListener('click', closeImageTagModal);
			}
			if (dom.cancelImgModalBtn) {
				dom.cancelImgModalBtn.addEventListener('click', closeImageTagModal);
			}
			dom.imgTagModalBackdrop.addEventListener('click', (e) => {
				if (e.target === dom.imgTagModalBackdrop) {
					closeImageTagModal();
				}
			});

			// Copy Generated Tag button inside modal
			if (dom.copyModalTagBtn) {
				dom.copyModalTagBtn.addEventListener('click', () => {
					const generatedSnippet = buildModalImageHtmlSnippet();
					copyToClipboard(generatedSnippet, 'Generated Image HTML Tag', dom.copyModalTagBtn);
				});
			}
		}
	}

	/* ==========================================================================
	   13. APPLICATION BOOTSTRAP
	   ========================================================================== */
	initBaseUrl();
	bindEvents();
	discoverAssets();
})();
