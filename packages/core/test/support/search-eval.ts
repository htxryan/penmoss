/**
 * The labelled evaluation set for semantic and hybrid search (T23, A12, A116),
 * each query naming the one note a person asking it wants:
 *
 * - `SEARCH_EVAL`: 30 concept queries over `SEARCH_VAULT` that share almost no
 *   words with their note, so only meaning finds it.
 * - `SEARCH_EVAL_KEYWORDS`: 20 queries that share their words with their
 *   note, each against a near-duplicate distractor (`EVAL_DISTRACTORS`) that
 *   shares most of those words too, so full-text and semantic each have
 *   something to get wrong and the fusion is measured.
 *
 * - `UNRELATED`: 10 queries about nothing in the vault, for the floor (A1155).
 * - `SEARCH_EVAL_HELD_OUT` with `HELD_OUT_DISTRACTORS`, and `UNRELATED_HELD_OUT`:
 *   kept out of tuning, to judge the floor the others chose (A1159).
 *
 * The target: the right note in the top 5 for at least 80% in hybrid, and
 * hybrid no worse than either side (`packages/git-notebook/scripts/eval-search.ts`).
 */
import type { VaultNote } from './search-vault';

export interface LabelledQuery {
  readonly query: string;
  readonly expected: string;
}

export const SEARCH_EVAL: readonly LabelledQuery[] = [
  { query: 'backup strategy for my notes', expected: 'git-mirror' },
  { query: 'keep the computers running during a blackout', expected: 'ups-shutdown' },
  { query: 'stop ads on every device in the house', expected: 'adguard-dns' },
  { query: 'lamps that switch on when it gets dark', expected: 'home-assistant' },
  { query: 'keep smart gadgets away from my laptop traffic', expected: 'network-vlans' },
  { query: 'encrypted cloud copy of family pictures', expected: 'offsite-backup' },
  { query: 'reach my servers while away from home', expected: 'tailscale' },
  { query: 'how much electricity the servers use', expected: 'homelab-power' },
  { query: 'when to move seedlings outside', expected: 'tomatoes' },
  { query: 'turning food waste into soil', expected: 'compost' },
  { query: 'bugs eating my vegetables', expected: 'pests' },
  { query: 'looking after the bread culture', expected: 'sourdough' },
  { query: 'dough for a wood-fired oven', expected: 'pizza-dough' },
  { query: 'cooking lunches for the whole week ahead', expected: 'meal-prep' },
  { query: 'brewing a good cup in the morning', expected: 'coffee' },
  { query: 'preparing for a 21 km race', expected: 'running-plan' },
  { query: 'trouble falling asleep', expected: 'sleep' },
  { query: 'rehab exercises after a leg injury', expected: 'physio' },
  { query: 'savings in case I lose my job', expected: 'emergency-fund' },
  { query: 'paperwork for the IRS', expected: 'taxes-2026' },
  { query: 'stop paying for services I never use', expected: 'subscriptions' },
  { query: 'saving for old age with the company match', expected: 'retirement' },
  { query: 'shrines and trains in Kyoto', expected: 'japan-trip' },
  { query: 'what to take on a flight with only hand luggage', expected: 'packing-list' },
  { query: 'equipment for sleeping outdoors', expected: 'camping' },
  { query: 'why the production server stopped accepting writes', expected: 'incident-review' },
  { query: 'concentrating without distractions', expected: 'deep-work' },
  { query: 'building small routines that stick', expected: 'atomic-habits' },
  { query: 'when the vehicle needs servicing', expected: 'car-maintenance' },
  { query: 'what to buy for birthdays', expected: 'gift-ideas' },
];

/** Keyword queries: every word is in the labelled note, and most are in its distractor too. */
export const SEARCH_EVAL_KEYWORDS: readonly LabelledQuery[] = [
  { query: 'restore notes from the git repository', expected: 'git-mirror' },
  { query: 'hourly snapshots kept for two days', expected: 'zfs-snapshots' },
  { query: 'neapolitan pizza dough hydration', expected: 'pizza-dough' },
  { query: 'feed the sourdough starter flour and water', expected: 'sourdough' },
  { query: 'pour-over coffee ratio', expected: 'coffee' },
  { query: 'long run on saturday before race day', expected: 'running-plan' },
  { query: 'high-yield savings account for a lost job', expected: 'emergency-fund' },
  { query: 'kyoto temples and the rail pass', expected: 'japan-trip' },
  { query: 'sleeping bag and tent for two', expected: 'camping' },
  { query: 'primary database ran out of disk', expected: 'incident-review' },
  { query: 'replace the furnace filter', expected: 'hvac' },
  { query: 'dog vaccines due', expected: 'dog-care' },
  { query: 'iot devices firewall rules vlan', expected: 'network-vlans' },
  { query: 'gather forms before filing the tax return', expected: 'taxes-2026' },
  { query: 'sow tomato seeds indoors under the grow light', expected: 'tomatoes' },
  { query: 'guests shut down in order when the power fails', expected: 'ups-shutdown' },
  { query: 'lamps turn on at sunset', expected: 'home-assistant' },
  { query: 'cal newport shutdown ritual', expected: 'deep-work' },
  { query: 'tyre pressure and oil changed', expected: 'car-maintenance' },
  { query: 'interview loop with a coding exercise and system design', expected: 'hiring' },
];

const distractor = (id: string, title: string, folder: VaultNote['folder'], body: string) => ({
  id,
  title,
  folder,
  tags: [],
  updated: '2026-09-15',
  body,
});

/** Near-duplicates of the keyword queries' notes: the same words, another subject. */
export const EVAL_DISTRACTORS: readonly VaultNote[] = [
  distractor(
    'git-cheatsheet',
    'Git commands cheat sheet',
    'Work',
    'Clone a repository, create a branch, commit and push to GitHub. Use git log to read the history of a file, and git restore to throw away local changes from the working tree.',
  ),
  distractor(
    'zfs-scrub',
    'ZFS pool maintenance',
    'Home Lab',
    'Scrub the pool on the first Sunday of every month. Replace a failing disk with zpool replace. Hourly snapshots of the backup server are kept for a week.',
  ),
  distractor(
    'pizza-sauce',
    'Neapolitan pizza sauce',
    'Kitchen',
    'San Marzano tomatoes crushed by hand with salt and a few basil leaves. The sauce is never cooked before it goes on the pizza.',
  ),
  distractor(
    'bagels',
    'Sourdough bagels',
    'Kitchen',
    'Mix the starter with bread flour and water, shape the bagels, rest them in the fridge overnight, then boil and bake.',
  ),
  distractor(
    'cold-brew',
    'Cold brew coffee',
    'Kitchen',
    'Coarse ground coffee steeped in cold water for sixteen hours in the fridge. The ratio is one to eight, diluted with water or milk to serve.',
  ),
  distractor(
    'trail-race',
    'Trail race plan',
    'Health',
    'A hilly ten kilometre trail race in the spring. The long run on Saturday goes on dirt trails, with hill repeats on Tuesday and rest the day before race day.',
  ),
  distractor(
    'savings-accounts',
    'Savings account comparison',
    'Money',
    'Compare high-yield savings accounts by APY, minimum balance and transfer limits. Moved the checking buffer to the online bank for a better rate.',
  ),
  distractor(
    'japan-rail',
    'Japan rail pass notes',
    'Travel',
    'Buy the rail pass before arriving and reserve bullet train seats from Tokyo to Kyoto. Most temples close at five, so plan the trains around them.',
  ),
  distractor(
    'tent-repair',
    'Tent repair kit',
    'Travel',
    'Seam sealer and patches for a torn tent, a spare pole section, and a stuff sack for two. The sleeping pad valve needs a spare too.',
  ),
  distractor(
    'migration-runbook',
    'Database migration runbook',
    'Work',
    'Take a backup, pause writes, run the migration on the primary database, check disk usage on the replica, then turn writes back on.',
  ),
  distractor(
    'water-filter',
    'Fridge water filter',
    'Home',
    'Replace the fridge water filter every six months. The part number is on the side of the old filter housing.',
  ),
  distractor(
    'puppy-training',
    'Puppy training',
    'Home',
    'Crate training for the new dog, sit and stay with treats, and the first vet visit for vaccines in two weeks.',
  ),
  distractor(
    'security-cameras',
    'Security cameras',
    'Home Lab',
    'Four PoE cameras record to Frigate. They sit on the IoT VLAN with the other devices and cannot reach the internet.',
  ),
  distractor(
    'tax-deductions',
    'Deductible expenses',
    'Money',
    'Track charitable donations, mortgage interest and home office costs through the year for the tax return.',
  ),
  distractor(
    'pepper-seeds',
    'Pepper seed starting',
    'Garden',
    'Sow pepper seeds indoors under the grow light in January on a heat mat, then transplant them after the last frost.',
  ),
  distractor(
    'ups-battery',
    'UPS battery replacement',
    'Home Lab',
    'Replace the UPS battery every three years. The 1500 VA unit takes two 12 V batteries; power the rack from the wall while swapping them.',
  ),
  distractor(
    'smart-plugs',
    'Smart plugs',
    'Home Lab',
    'Smart plugs on the IoT network report the power the rack and the television use, and turn the lamps on at sunset.',
  ),
  distractor(
    'digital-minimalism',
    'Digital Minimalism by Cal Newport',
    'Reading',
    'Declutter apps and social media with a thirty-day break, then bring back only what serves a deliberate purpose. Newport again argues for focus.',
  ),
  distractor(
    'winter-tyres',
    'Winter tyres',
    'Home',
    'Swap to winter tyres in November and check the tyre pressure every month. The spare is under the boot floor.',
  ),
  distractor(
    'design-questions',
    'System design interview questions',
    'Work',
    'Design a URL shortener, design a chat app, and a coding exercise to warm up before each interview.',
  ),
];

/**
 * Queries about nothing in the vault (T42, A571, kept by A1155): a hit found only by meaning
 * should not answer them. The floor is tuned so these find nothing by meaning while the 50
 * labelled queries keep their top 5 and MRR.
 */
export const UNRELATED: readonly string[] = [
  'zqxjkv wplmorth',
  'quantum chromodynamics lattice gauge theory',
  'medieval tapestry weaving looms',
  'saxophone reed strength for jazz',
  'volcanic rock formations in Iceland',
  'cricket bowling technique for spin',
  'knitting a cable sweater pattern',
  'xyzzy plugh',
  'the history of the Byzantine empire',
  'how to tune a ukulele',
];

/**
 * Held out from tuning (A1159): 20 paraphrases of notes the concept queries do not ask for, each against a
 * near-duplicate distractor (`HELD_OUT_DISTRACTORS`) on the same subject. The bar: the labelled
 * note in hybrid's top 5 for at least 16, at the floor the 50 and `UNRELATED` chose.
 */
export const SEARCH_EVAL_HELD_OUT: readonly LabelledQuery[] = [
  { query: 'the box that runs all my virtual machines', expected: 'proxmox-host' },
  {
    query: 'naming television episodes so the media server recognises them',
    expected: 'plex-library',
  },
  { query: 'copying films off physical discs onto the server', expected: 'disc-ripping' },
  { query: 'what soil goes into the wooden vegetable boxes', expected: 'raised-beds' },
  { query: 'how often the irrigation runs in a heat wave', expected: 'watering' },
  { query: 'fast things to cook after work', expected: 'weeknight-meals' },
  { query: 'a spicy stew made from leftover barbecue', expected: 'chili' },
  { query: 'results from my yearly physical', expected: 'doctor-visits' },
  { query: 'which lifts I do on which days', expected: 'strength' },
  { query: 'where my pay goes each month', expected: 'budget' },
  { query: 'renewing the cover on the house', expected: 'insurance' },
  { query: 'a long weekend driving around central Texas', expected: 'road-trip' },
  { query: 'replacing my travel document before it expires', expected: 'passport' },
  { query: 'questions for my regular chat with a direct report', expected: 'one-on-one' },
  { query: 'measurable goals for the team this quarter', expected: 'okrs' },
  { query: 'how quickly to look at a colleague’s pull request', expected: 'code-review' },
  { query: 'chores before relocating to a new address', expected: 'move-checklist' },
  { query: 'my end-of-week reflection and planning', expected: 'weekly-review' },
  { query: 'software I might build one day', expected: 'app-ideas' },
  { query: 'looking after the heating and cooling system', expected: 'hvac' },
];

/** Near-duplicates of the held-out queries' notes: the same subject, the wrong answer. */
export const HELD_OUT_DISTRACTORS: readonly VaultNote[] = [
  distractor(
    'nas-build',
    'NAS build',
    'Home Lab',
    'A four-bay box of spinning disks running TrueNAS for the media share and Time Machine. It sleeps the disks after an hour and wakes on LAN.',
  ),
  distractor(
    'music-library',
    'Music library tags',
    'Home Lab',
    'Albums are tagged with MusicBrainz Picard, one folder per artist and then per album, with the cover art saved beside the tracks.',
  ),
  distractor(
    'vinyl-records',
    'Digitising vinyl',
    'Home Lab',
    'Record each side of an album through the USB turntable into Audacity, split the tracks at the silences and save them as FLAC.',
  ),
  distractor(
    'houseplants',
    'Houseplant potting mix',
    'Garden',
    'Peat-free compost with perlite and orchid bark for the pothos and the monstera. Repot in spring into a pot one size larger.',
  ),
  distractor(
    'lawn',
    'Lawn care',
    'Garden',
    'Mow high in summer and leave the clippings. Overseed the bare patches with fescue in October and aerate every other year.',
  ),
  distractor(
    'dinner-party',
    'Dinner party menu',
    'Kitchen',
    'A braised short rib main that cooks all afternoon, a big salad, and a tart made the day before. Eight guests, so double the recipe.',
  ),
  distractor(
    'brisket',
    'Smoking a brisket',
    'Kitchen',
    'Trim the fat cap, season with salt and pepper, smoke overnight over post oak at 250 degrees, wrap in butcher paper and rest for two hours.',
  ),
  distractor(
    'dentist',
    'Dental cleaning',
    'Health',
    'Cleaning every six months. One small cavity on a back molar to fill next visit; floss more on the left side.',
  ),
  distractor(
    'yoga',
    'Yoga routine',
    'Health',
    'Twenty minutes of sun salutations, pigeon pose and a long twist on the mornings between runs, to keep the hips loose.',
  ),
  distractor(
    'payroll',
    'Payroll deductions',
    'Money',
    'The pay stub lists federal withholding, Social Security, Medicare, the health plan premium and the retirement contribution before net pay.',
  ),
  distractor(
    'car-insurance',
    'Car insurance',
    'Money',
    'Six-month auto policy with liability, collision and comprehensive. Raising the deductible to 1,000 lowered the premium.',
  ),
  distractor(
    'big-bend',
    'Big Bend trip',
    'Travel',
    'Camp three nights in Big Bend National Park in West Texas, hike the Lost Mine Trail at sunrise and soak in the hot springs by the river.',
  ),
  distractor(
    'travel-insurance',
    'Travel insurance',
    'Travel',
    'Buy cover for medical evacuation and trip cancellation before booking flights abroad, and keep the policy number with the boarding passes.',
  ),
  distractor(
    'retro',
    'Sprint retrospective',
    'Work',
    'Every two weeks the team lists what went well, what did not and one experiment to try in the next sprint.',
  ),
  distractor(
    'roadmap',
    'Product roadmap',
    'Work',
    'Now: offline editing. Next: sharing a folder with a link. Later: a desktop widget. Each item names a customer who asked for it.',
  ),
  distractor(
    'pr-template',
    'Pull request template',
    'Work',
    'Every pull request explains what changed, why, how it was tested and what to watch after deploying, with screenshots for UI changes.',
  ),
  distractor(
    'house-hunting',
    'House hunting',
    'Home',
    'Three bedrooms, a yard for the dog and under thirty minutes to the office. Check the flood map and the school ratings before an offer.',
  ),
  distractor(
    'daily-planning',
    'Daily planning',
    'Journal',
    'Each morning pick one task that matters most, block two hours for it and leave the inbox until noon.',
  ),
  distractor(
    'side-business',
    'Side business',
    'Work',
    'Ideas for earning on the side: selling prints of my photographs, teaching a weekend workshop and freelance consulting.',
  ),
  distractor(
    'fireplace',
    'Wood stove',
    'Home',
    'Have the chimney swept every autumn, burn only seasoned oak and keep the carbon monoxide alarm tested.',
  ),
];

/** Held out too: 10 more queries about nothing in the vault, none used to tune the floor. */
export const UNRELATED_HELD_OUT: readonly string[] = [
  'bioluminescent fish in the deep ocean',
  'origami crane folding steps',
  'baroque harpsichord tuning temperaments',
  'ancient Egyptian hieroglyph grammar',
  'rook and pawn chess endgames',
  'glacier calving in Antarctica',
  'competitive yo-yo tricks',
  'Puccini opera arias',
  'curling stone sweeping technique',
  'qwvbnz trelk',
];
