/**
 * Where a posting is — the places named in its free-text `location` — and
 * which places lie within a radius of somewhere, for the feed's `near=` filter.
 *
 * Postings say where they are in every way there is: "San Francisco, CA |
 * New York City, NY", "US-CA-Menlo Park", "Sao Paulo, Sao Paulo, Brasil",
 * "Massachusetts - Boston" (sampled from the live corpus 2026-11-06). So this
 * finds EVERY known place a string names rather than parsing one: a phrase
 * match on folded text (lower case, accents stripped, punctuation as spaces).
 *
 * A name more than one place has (Cambridge MA / UK, Arlington VA / TX) is
 * settled by region evidence in the same string — a state code in UPPER case
 * ("CA", never the words "or" / "in" / "me"), a state or country name — and
 * otherwise goes to the place declared first. A place whose name is also a
 * US state ("Washington") needs that evidence outright, or "Seattle,
 * Washington" would put a posting in DC.
 *
 * The US table is JobPulse's US_CITY_COORDINATES (152 metros, hubs and
 * suburbs), ported 2026-11-06; the rest was added for the corpus's
 * international postings. Coordinates are city centres to ~0.01°, which is
 * far finer than any radius anyone asks for.
 */

export interface Place {
	/** Stable id, `<name-slug>-<region>`; what jobs.geo_keys stores. */
	key: string;
	name: string;
	/** US state code, or ISO country code for anywhere else. */
	region: string;
	lat: number;
	lng: number;
}

type Row = [name: string, region: string, lat: number, lng: number];

const US: Row[] = [
	['arlington', 'va', 38.8799, -77.1068],
	['austin', 'tx', 30.2672, -97.7431],
	['round rock', 'tx', 30.5083, -97.6789],
	['cedar park', 'tx', 30.5052, -97.8203],
	['georgetown', 'tx', 30.6333, -97.6778],
	['san marcos', 'tx', 29.8833, -97.9414],
	['dallas', 'tx', 32.7767, -96.797],
	['fort worth', 'tx', 32.7555, -97.3308],
	['plano', 'tx', 33.0198, -96.6989],
	['irving', 'tx', 32.814, -96.9489],
	['frisco', 'tx', 33.1507, -96.8236],
	['richardson', 'tx', 32.9483, -96.7299],
	['arlington', 'tx', 32.7357, -97.1081],
	['houston', 'tx', 29.7604, -95.3698],
	['the woodlands', 'tx', 30.1588, -95.4613],
	['sugar land', 'tx', 29.6197, -95.6349],
	['san antonio', 'tx', 29.4241, -98.4936],
	['el paso', 'tx', 31.7619, -106.485],
	['lubbock', 'tx', 33.5779, -101.8552],
	['midland', 'tx', 31.9973, -102.0779],
	['san francisco', 'ca', 37.7749, -122.4194],
	['oakland', 'ca', 37.8044, -122.2712],
	['berkeley', 'ca', 37.8715, -122.273],
	['san jose', 'ca', 37.3382, -121.8863],
	['sunnyvale', 'ca', 37.3688, -122.0363],
	['santa clara', 'ca', 37.3541, -121.9552],
	['mountain view', 'ca', 37.3861, -122.0839],
	['palo alto', 'ca', 37.4419, -122.143],
	['menlo park', 'ca', 37.453, -122.1817],
	['redwood city', 'ca', 37.4852, -122.2364],
	['san mateo', 'ca', 37.563, -122.3255],
	['cupertino', 'ca', 37.323, -122.0322],
	['fremont', 'ca', 37.5485, -121.9886],
	['pleasanton', 'ca', 37.6624, -121.8747],
	['san ramon', 'ca', 37.7799, -121.978],
	['walnut creek', 'ca', 37.9101, -122.0652],
	['san rafael', 'ca', 37.9735, -122.5311],
	['sacramento', 'ca', 38.5816, -121.4944],
	['fresno', 'ca', 36.7468, -119.7726],
	['los angeles', 'ca', 34.0522, -118.2437],
	['santa monica', 'ca', 34.0195, -118.4912],
	['culver city', 'ca', 34.0211, -118.3965],
	['pasadena', 'ca', 34.1478, -118.1445],
	['burbank', 'ca', 34.1808, -118.309],
	['glendale', 'ca', 34.1425, -118.2551],
	['long beach', 'ca', 33.7701, -118.1937],
	['irvine', 'ca', 33.6846, -117.8265],
	['newport beach', 'ca', 33.6189, -117.9298],
	['anaheim', 'ca', 33.8366, -117.9143],
	['san diego', 'ca', 32.7157, -117.1611],
	['la jolla', 'ca', 32.8328, -117.2713],
	['carlsbad', 'ca', 33.1581, -117.3506],
	['riverside', 'ca', 33.9806, -117.3755],
	['seattle', 'wa', 47.6062, -122.3321],
	['bellevue', 'wa', 47.6101, -122.2015],
	['redmond', 'wa', 47.674, -122.1215],
	['kirkland', 'wa', 47.6769, -122.206],
	['renton', 'wa', 47.4829, -122.2171],
	['bothell', 'wa', 47.7601, -122.2054],
	['tacoma', 'wa', 47.2529, -122.4443],
	['olympia', 'wa', 47.0379, -122.9007],
	['spokane', 'wa', 47.6588, -117.426],
	['new york', 'ny', 40.7128, -74.006],
	['manhattan', 'ny', 40.7831, -73.9712],
	['brooklyn', 'ny', 40.6782, -73.9442],
	['queens', 'ny', 40.7282, -73.7949],
	['bronx', 'ny', 40.8448, -73.8648],
	['staten island', 'ny', 40.5795, -74.1502],
	['white plains', 'ny', 41.034, -73.7629],
	['buffalo', 'ny', 42.8864, -78.8784],
	['rochester', 'ny', 43.1566, -77.6088],
	['albany', 'ny', 42.6526, -73.7562],
	['jersey city', 'nj', 40.7178, -74.0431],
	['hoboken', 'nj', 40.744, -74.0324],
	['newark', 'nj', 40.7357, -74.1724],
	['princeton', 'nj', 40.3573, -74.6672],
	['boston', 'ma', 42.3601, -71.0589],
	['cambridge', 'ma', 42.3736, -71.1097],
	['somerville', 'ma', 42.3876, -71.0995],
	['waltham', 'ma', 42.3765, -71.2356],
	['burlington', 'ma', 42.5048, -71.1956],
	['newton', 'ma', 42.337, -71.2092],
	['quincy', 'ma', 42.2529, -71.0023],
	['worcester', 'ma', 42.2626, -71.8023],
	['providence', 'ri', 41.824, -71.4128],
	['hartford', 'ct', 41.7658, -72.6734],
	['stamford', 'ct', 41.0534, -73.5387],
	['chicago', 'il', 41.8781, -87.6298],
	['evanston', 'il', 42.0451, -87.6877],
	['naperville', 'il', 41.7508, -88.1535],
	['schaumburg', 'il', 42.0334, -88.0834],
	['minneapolis', 'mn', 44.9778, -93.265],
	['st. paul', 'mn', 44.9537, -93.09],
	['bloomington', 'mn', 44.8408, -93.2983],
	['detroit', 'mi', 42.3314, -83.0458],
	['ann arbor', 'mi', 42.2808, -83.743],
	['grand rapids', 'mi', 42.9634, -85.6681],
	['columbus', 'oh', 39.9612, -82.9988],
	['cleveland', 'oh', 41.4993, -81.6944],
	['cincinnati', 'oh', 39.1031, -84.512],
	['indianapolis', 'in', 39.7684, -86.1581],
	['milwaukee', 'wi', 43.0389, -87.9065],
	['madison', 'wi', 43.0731, -89.4012],
	['st. louis', 'mo', 38.627, -90.1994],
	['kansas city', 'mo', 39.0997, -94.5786],
	['denver', 'co', 39.7392, -104.9903],
	['boulder', 'co', 40.015, -105.2705],
	['colorado springs', 'co', 38.8339, -104.8214],
	['fort collins', 'co', 40.5853, -105.0844],
	['broomfield', 'co', 39.9205, -105.0867],
	['salt lake city', 'ut', 40.7608, -111.891],
	['lehi', 'ut', 40.3892, -111.8508],
	['provo', 'ut', 40.2338, -111.6585],
	['draper', 'ut', 40.5247, -111.8638],
	['phoenix', 'az', 33.4484, -112.074],
	['scottsdale', 'az', 33.4942, -111.9261],
	['tempe', 'az', 33.4255, -111.94],
	['chandler', 'az', 33.3062, -111.8413],
	['tucson', 'az', 32.2226, -110.9747],
	['las vegas', 'nv', 36.1699, -115.1398],
	['reno', 'nv', 39.5296, -119.8138],
	['atlanta', 'ga', 33.749, -84.388],
	['alpharetta', 'ga', 34.0754, -84.2941],
	['marietta', 'ga', 33.9526, -84.5499],
	['raleigh', 'nc', 35.7796, -78.6382],
	['durham', 'nc', 35.994, -78.8986],
	['chapel hill', 'nc', 35.9132, -79.0558],
	['cary', 'nc', 35.7915, -78.7811],
	['charlotte', 'nc', 35.2271, -80.8431],
	['washington', 'dc', 38.9072, -77.0369],
	['alexandria', 'va', 38.8048, -77.0469],
	['mclean', 'va', 38.9339, -77.1773],
	['tysons', 'va', 38.9187, -77.2311],
	['reston', 'va', 38.9586, -77.357],
	['herndon', 'va', 38.9696, -77.3861],
	['richmond', 'va', 37.5407, -77.436],
	['bethesda', 'md', 38.9847, -77.0947],
	['baltimore', 'md', 39.2904, -76.6122],
	['rockville', 'md', 39.084, -77.1528],
	['philadelphia', 'pa', 39.9526, -75.1652],
	['pittsburgh', 'pa', 40.4406, -79.9959],
	['miami', 'fl', 25.7617, -80.1918],
	['fort lauderdale', 'fl', 26.1224, -80.1373],
	['tampa', 'fl', 27.9506, -82.4572],
	['orlando', 'fl', 28.5383, -81.3792],
	['jacksonville', 'fl', 30.3322, -81.6557],
	['nashville', 'tn', 36.1627, -86.7816],
	['memphis', 'tn', 35.1495, -90.049],
	['portland', 'or', 45.5152, -122.6784],
	['beaverton', 'or', 45.4871, -122.8037],
	['hillsboro', 'or', 45.5229, -122.9898],
	['boise', 'id', 43.615, -116.2023],
	// Added: suburbs and hubs the live corpus names that the port did not have.
	['foster city', 'ca', 37.5585, -122.2711],
	['south san francisco', 'ca', 37.6547, -122.4077],
	['emeryville', 'ca', 37.8313, -122.2852],
	['milpitas', 'ca', 37.4323, -121.8996],
	['los gatos', 'ca', 37.2358, -121.9624],
	['san bruno', 'ca', 37.6305, -122.4111],
	['hayward', 'ca', 37.6688, -122.0808],
	['el segundo', 'ca', 33.9192, -118.4165],
	['torrance', 'ca', 33.8358, -118.3406],
	['hollywood', 'fl', 26.0112, -80.1495],
	['boca raton', 'fl', 26.3683, -80.1289],
	['new orleans', 'la', 29.9511, -90.0715],
	['louisville', 'ky', 38.2527, -85.7585],
	['oklahoma city', 'ok', 35.4676, -97.5164],
	['omaha', 'ne', 41.2565, -95.9345],
	['des moines', 'ia', 41.5868, -93.625],
	['albuquerque', 'nm', 35.0844, -106.6504],
	['honolulu', 'hi', 21.3099, -157.8581],
	['anchorage', 'ak', 61.2181, -149.9003],
	['burlington', 'vt', 44.4759, -73.2121],
	['portland', 'me', 43.6591, -70.2568],
];

/** Elsewhere, by ISO country code. A name shared with a US place comes AFTER it. */
const WORLD: Row[] = [
	// Canada
	['toronto', 'ca-on', 43.6532, -79.3832],
	['etobicoke', 'ca-on', 43.6205, -79.5132],
	['mississauga', 'ca-on', 43.589, -79.6441],
	['waterloo', 'ca-on', 43.4643, -80.5204],
	['ottawa', 'ca-on', 45.4215, -75.6972],
	['montreal', 'ca-qc', 45.5017, -73.5673],
	['vancouver', 'ca-bc', 49.2827, -123.1207],
	['calgary', 'ca-ab', 51.0447, -114.0719],
	// Latin America
	['mexico city', 'mx', 19.4326, -99.1332],
	['guadalajara', 'mx', 20.6597, -103.3496],
	['sao paulo', 'br', -23.5505, -46.6333],
	['rio de janeiro', 'br', -22.9068, -43.1729],
	['buenos aires', 'ar', -34.6037, -58.3816],
	['bogota', 'co', 4.711, -74.0721],
	['santiago', 'cl', -33.4489, -70.6693],
	// Europe
	['london', 'gb', 51.5074, -0.1278],
	['cambridge', 'gb', 52.2053, 0.1218],
	['manchester', 'gb', 53.4808, -2.2426],
	['edinburgh', 'gb', 55.9533, -3.1883],
	['dublin', 'ie', 53.3498, -6.2603],
	['cork', 'ie', 51.8985, -8.4756],
	['berlin', 'de', 52.52, 13.405],
	['munich', 'de', 48.1351, 11.582],
	['hamburg', 'de', 53.5511, 9.9937],
	['frankfurt', 'de', 50.1109, 8.6821],
	['amsterdam', 'nl', 52.3676, 4.9041],
	['paris', 'fr', 48.8566, 2.3522],
	['brussels', 'be', 50.8503, 4.3517],
	['zurich', 'ch', 47.3769, 8.5417],
	['geneva', 'ch', 46.2044, 6.1432],
	['vienna', 'at', 48.2082, 16.3738],
	['stockholm', 'se', 59.3293, 18.0686],
	['copenhagen', 'dk', 55.6761, 12.5683],
	['oslo', 'no', 59.9139, 10.7522],
	['helsinki', 'fi', 60.1699, 24.9384],
	['madrid', 'es', 40.4168, -3.7038],
	['barcelona', 'es', 41.3874, 2.1686],
	['lisbon', 'pt', 38.7223, -9.1393],
	['warsaw', 'pl', 52.2297, 21.0122],
	['krakow', 'pl', 50.0647, 19.945],
	['prague', 'cz', 50.0755, 14.4378],
	['bucharest', 'ro', 44.4268, 26.1025],
	['athens', 'gr', 37.9838, 23.7275],
	['istanbul', 'tr', 41.0082, 28.9784],
	// Middle East and Africa
	['tel aviv', 'il', 32.0853, 34.7818],
	['dubai', 'ae', 25.2048, 55.2708],
	['riyadh', 'sa', 24.7136, 46.6753],
	['abu dhabi', 'ae', 24.4539, 54.3773],
	['cairo', 'eg', 30.0444, 31.2357],
	['lagos', 'ng', 6.5244, 3.3792],
	['nairobi', 'ke', -1.2921, 36.8219],
	['cape town', 'za', -33.9249, 18.4241],
	// Asia-Pacific
	['bengaluru', 'in', 12.9716, 77.5946],
	['hyderabad', 'in', 17.385, 78.4867],
	['pune', 'in', 18.5204, 73.8567],
	['mumbai', 'in', 19.076, 72.8777],
	['chennai', 'in', 13.0827, 80.2707],
	['gurugram', 'in', 28.4595, 77.0266],
	['noida', 'in', 28.5355, 77.391],
	['new delhi', 'in', 28.6139, 77.209],
	['singapore', 'sg', 1.3521, 103.8198],
	['kuala lumpur', 'my', 3.139, 101.6869],
	['jakarta', 'id', -6.2088, 106.8456],
	['manila', 'ph', 14.5995, 120.9842],
	['tokyo', 'jp', 35.6762, 139.6503],
	['osaka', 'jp', 34.6937, 135.5023],
	['bangkok', 'th', 13.7563, 100.5018],
	['seoul', 'kr', 37.5665, 126.978],
	['taipei', 'tw', 25.033, 121.5654],
	['taoyuan', 'tw', 24.9936, 121.301],
	['hong kong', 'hk', 22.3193, 114.1694],
	['shanghai', 'cn', 31.2304, 121.4737],
	['beijing', 'cn', 39.9042, 116.4074],
	['shenzhen', 'cn', 22.5431, 114.0579],
	['sydney', 'au', -33.8688, 151.2093],
	['melbourne', 'au', -37.8136, 144.9631],
	['auckland', 'nz', -36.8485, 174.7633],
	// US places that share a name with one above, declared after it so the
	// bare name keeps meaning the other: "Dublin" alone is Ireland.
	['dublin', 'ca', 37.7022, -121.9358],
];

/** Other spellings of a place, folded. Each maps to `<name>|<region>` above. */
const ALIASES: Record<string, string> = {
	'new york city': 'new york|ny',
	nyc: 'new york|ny',
	'st paul': 'st. paul|mn',
	'saint paul': 'st. paul|mn',
	'saint louis': 'st. louis|mo',
	'st louis': 'st. louis|mo',
	'washington dc': 'washington|dc',
	'washington d c': 'washington|dc',
	bangalore: 'bengaluru|in',
	gurgaon: 'gurugram|in',
	delhi: 'new delhi|in',
	munchen: 'munich|de',
	'tel aviv yafo': 'tel aviv|il',
};

const US_STATES: Record<string, string> = {
	al: 'alabama',
	ak: 'alaska',
	az: 'arizona',
	ar: 'arkansas',
	ca: 'california',
	co: 'colorado',
	ct: 'connecticut',
	de: 'delaware',
	fl: 'florida',
	ga: 'georgia',
	hi: 'hawaii',
	id: 'idaho',
	il: 'illinois',
	in: 'indiana',
	ia: 'iowa',
	ks: 'kansas',
	ky: 'kentucky',
	la: 'louisiana',
	me: 'maine',
	md: 'maryland',
	ma: 'massachusetts',
	mi: 'michigan',
	mn: 'minnesota',
	ms: 'mississippi',
	mo: 'missouri',
	mt: 'montana',
	ne: 'nebraska',
	nv: 'nevada',
	nh: 'new hampshire',
	nj: 'new jersey',
	nm: 'new mexico',
	ny: 'new york',
	nc: 'north carolina',
	nd: 'north dakota',
	oh: 'ohio',
	ok: 'oklahoma',
	or: 'oregon',
	pa: 'pennsylvania',
	ri: 'rhode island',
	sc: 'south carolina',
	sd: 'south dakota',
	tn: 'tennessee',
	tx: 'texas',
	ut: 'utah',
	vt: 'vermont',
	va: 'virginia',
	wa: 'washington',
	wv: 'west virginia',
	wi: 'wisconsin',
	wy: 'wyoming',
	dc: 'district of columbia',
};

/** Folded words that place a string in a non-US region. */
const COUNTRY_WORDS: Record<string, string[]> = {
	'ca-on': ['canada', 'ontario'],
	'ca-qc': ['canada', 'quebec'],
	'ca-bc': ['canada', 'british columbia'],
	'ca-ab': ['canada', 'alberta'],
	mx: ['mexico'],
	br: ['brazil', 'brasil'],
	ar: ['argentina'],
	co: ['colombia'],
	cl: ['chile'],
	gb: ['uk', 'united kingdom', 'england', 'scotland', 'great britain'],
	ie: ['ireland'],
	de: ['germany', 'deutschland'],
	nl: ['netherlands'],
	fr: ['france'],
	be: ['belgium'],
	ch: ['switzerland'],
	at: ['austria'],
	se: ['sweden'],
	dk: ['denmark'],
	no: ['norway'],
	fi: ['finland'],
	es: ['spain'],
	pt: ['portugal'],
	pl: ['poland'],
	cz: ['czechia', 'czech republic'],
	ro: ['romania'],
	gr: ['greece'],
	tr: ['turkey', 'turkiye'],
	il: ['israel'],
	ae: ['uae', 'united arab emirates'],
	eg: ['egypt'],
	ng: ['nigeria'],
	ke: ['kenya'],
	za: ['south africa'],
	in: ['india'],
	sg: ['singapore'],
	my: ['malaysia'],
	id: ['indonesia'],
	ph: ['philippines'],
	jp: ['japan'],
	kr: ['korea', 'south korea'],
	tw: ['taiwan'],
	hk: ['hong kong'],
	cn: ['china'],
	au: ['australia'],
	nz: ['new zealand'],
	th: ['thailand'],
	sa: ['saudi arabia'],
};

/** Lower case, accents stripped, every run of non-letters/digits one space, padded. */
function fold(s: string): string {
	return ` ${s
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()} `;
}

function slug(name: string): string {
	return fold(name).trim().replace(/ /g, '-');
}

const PLACES: Place[] = [...US, ...WORLD].map(([name, region, lat, lng]) => ({
	key: `${slug(name)}-${region}`,
	name,
	region,
	lat,
	lng,
}));

const BY_KEY = new Map(PLACES.map((p) => [p.key, p]));

/** Folded phrase → the places it may mean, in declaration order. */
const BY_PHRASE = new Map<string, Place[]>();
function addPhrase(phrase: string, place: Place) {
	const f = fold(phrase);
	const list = BY_PHRASE.get(f) ?? [];
	if (!list.includes(place)) list.push(place);
	BY_PHRASE.set(f, list);
}
for (const p of PLACES) addPhrase(p.name, p);
for (const [alias, target] of Object.entries(ALIASES)) {
	const [name, region] = target.split('|');
	const p = BY_KEY.get(`${slug(name)}-${region}`);
	if (!p) throw new Error(`geo alias '${alias}' names no place (${target})`);
	addPhrase(alias, p);
}
// Longest phrase first, so "new york city" is tried before "new york".
const PHRASES = [...BY_PHRASE.keys()].sort((a, b) => b.length - a.length);

const STATE_NAMES = new Set(Object.values(US_STATES));
const ALL_REGIONS = [...Object.keys(US_STATES), ...Object.keys(COUNTRY_WORDS)];

/** Does the string carry evidence that it means this place's region? */
function regionNamed(raw: string, folded: string, region: string): boolean {
	const stateName = US_STATES[region];
	if (stateName) {
		// A state CODE only in upper case: lower-case "or", "in", "me" and "de"
		// are words in nearly every location string.
		const code = region.toUpperCase();
		if (new RegExp(`(?:^|[^A-Za-z])${code}(?:[^A-Za-z]|$)`).test(raw)) return true;
		if (region === 'dc' && /\bD\.C\.?/.test(raw)) return true;
		return folded.includes(` ${stateName} `);
	}
	return (COUNTRY_WORDS[region] ?? []).some((w) => folded.includes(fold(w)));
}

/**
 * The one region a segment names, when it names exactly one — "Hollywood, CA"
 * names California, so the Florida Hollywood is not what it means. A segment
 * naming several ("San Francisco, CA, New York, NY") proves nothing about any
 * one place in it.
 */
function soleRegion(raw: string, folded: string): string | null {
	const named = ALL_REGIONS.filter((r) => regionNamed(raw, folded, r));
	return named.length === 1 ? named[0] : null;
}

/**
 * Postings list places with these between them; evidence is read per segment.
 * Case-sensitive on purpose: " or " splits, ", OR" (Oregon) does not.
 */
const SEGMENT = /\s*[|;/]\s*|\s+or\s+|\s+and\s+/;

function placesInSegment(raw: string, found: Place[]): void {
	const evidenceText = fold(raw);
	let folded = evidenceText;
	const sole = soleRegion(raw, evidenceText);
	for (const phrase of PHRASES) {
		if (!folded.includes(phrase)) continue;
		const candidates = BY_PHRASE.get(phrase)!;
		const evidenced = candidates.filter((p) => regionNamed(raw, evidenceText, p.region));
		let pick: Place | undefined = evidenced[0];
		if (!pick) {
			// No evidence: the first-declared candidate — unless its name is
			// also a state's that is not its own ("Washington" the city), which
			// without evidence almost always means the state; or unless the
			// segment names one other region outright.
			const first = candidates[0];
			const isOtherState = STATE_NAMES.has(first.name) && US_STATES[first.region] !== first.name;
			const elsewhere = sole !== null && !candidates.some((p) => p.region === sole);
			if (!isOtherState && !elsewhere) pick = first;
		}
		if (pick && !found.includes(pick)) found.push(pick);
		// Consume the phrase so "new york city" is not read again as "new york".
		folded = folded.split(phrase).join(' | ');
	}
}

/** Every known place a location string names, each once, in the order found. */
export function findPlaces(location: string): Place[] {
	if (!location) return [];
	const found: Place[] = [];
	for (const segment of location.split(SEGMENT)) {
		if (segment.trim()) placesInSegment(segment, found);
	}
	return found;
}

/** What jobs.geo_keys stores: `|key|key|`, or '' when no known place is named. */
export function geoKeys(location: string): string {
	const keys = findPlaces(location).map((p) => p.key);
	return keys.length ? `|${keys.join('|')}|` : '';
}

const EARTH_RADIUS_MILES = 3958.8;

export function milesBetween(a: Place, b: Place): number {
	const rad = (d: number) => (d * Math.PI) / 180;
	const dLat = rad(b.lat - a.lat);
	const dLng = rad(b.lng - a.lng);
	const h =
		Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
	return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h));
}

/** A place by its key, or the first place a free-text query names. */
export function resolvePlace(q: string): Place | null {
	return BY_KEY.get(q.trim().toLowerCase()) ?? findPlaces(q)[0] ?? null;
}

/** Every known place within `miles` of `center`, nearest first (the center included). */
export function placesWithin(center: Place, miles: number): Place[] {
	return PLACES.map((p) => ({ p, d: milesBetween(center, p) }))
		.filter(({ d }) => d <= miles)
		.sort((a, b) => a.d - b.d)
		.map(({ p }) => p);
}

/** Places whose name starts with (or contains) the query, for a picker. */
export function searchPlaces(q: string, limit = 10): Place[] {
	const f = fold(q).trim();
	if (!f) return [];
	const starts = PLACES.filter((p) => fold(p.name).trim().startsWith(f));
	const contains = PLACES.filter((p) => !starts.includes(p) && fold(p.name).includes(f));
	return [...starts, ...contains].slice(0, limit);
}
