/**
 * The seeded sample vault for search (T22, T23): sixty short notes of a
 * fictional personal knowledge base across ten folders, written so that
 * related notes share vocabulary (two kinds of backup, two kinds of dough)
 * and concept queries need meaning, not words. Used by the ranking
 * regression and offline-parity tests, the e2e search spec and
 * `scripts/eval-search.ts` (the labelled queries are in `search-eval.ts`).
 */
export interface VaultNote {
  readonly id: string;
  readonly title: string;
  readonly folder: string;
  readonly tags: readonly string[];
  /** Last updated, YYYY-MM-DD (UTC midnight). */
  readonly updated: string;
  /** The body as markdown (no frontmatter, no inline tags). */
  readonly body: string;
}

export const VAULT_FOLDERS = [
  'Home Lab',
  'Garden',
  'Kitchen',
  'Health',
  'Money',
  'Travel',
  'Work',
  'Reading',
  'Home',
  'Journal',
] as const;

const note = (
  id: string,
  title: string,
  folder: (typeof VAULT_FOLDERS)[number],
  tags: string[],
  updated: string,
  body: string,
): VaultNote => ({ id, title, folder, tags, updated, body: body.trim() });

export const SEARCH_VAULT: readonly VaultNote[] = [
  note(
    'git-mirror',
    'Git mirror of the vault',
    'Home Lab',
    ['homelab', 'backup'],
    '2026-10-01',
    `
Every night a job exports each note as a markdown file and pushes the folder to a private GitHub repository. The history in git means any earlier version of a note can be found again.

## Why
The notes live on one small server at home. If that machine dies, the repository still holds every note as plain text that any editor can open.

## Restoring
Clone the repository onto a new machine and import the folder. Check that the newest commit is from last night before trusting it.
`,
  ),
  note(
    'proxmox-host',
    'Proxmox host',
    'Home Lab',
    ['homelab'],
    '2026-09-12',
    `
The host is a fanless mini PC with 64 GB of memory and two NVMe drives in a mirror.

## Virtual machines
Home Assistant, the media server, the DNS filter and a Linux worker for agents each run in their own virtual machine or container.

## Storage
A ZFS pool holds the guests' disks; a separate dataset keeps ISO images and templates.
`,
  ),
  note(
    'ups-shutdown',
    'UPS and safe shutdown',
    'Home Lab',
    ['homelab', 'power'],
    '2026-08-03',
    `
A 1500 VA uninterruptible power supply sits under the rack. Network UPS Tools watches its battery over USB.

## When the power fails
After two minutes on battery, the guests shut down in order: media server first, then Home Assistant, then the host itself. The battery lasts about eighteen minutes at idle load.

## Testing
Pull the wall plug once a quarter and time how long the shutdown sequence takes.
`,
  ),
  note(
    'adguard-dns',
    'AdGuard DNS',
    'Home Lab',
    ['homelab', 'network'],
    '2026-07-21',
    `
AdGuard Home answers DNS for the whole house and drops requests to known tracking and advertising domains.

## Upstream resolvers
Queries go out over DNS-over-HTTPS to two public resolvers.

## Allow list
Shopping sites sometimes break; add their domains to the allow list rather than switching filtering off.
`,
  ),
  note(
    'plex-library',
    'Plex library layout',
    'Home Lab',
    ['homelab', 'media'],
    '2026-06-30',
    `
Movies and shows live in separate folders on the media share, one folder per title with the year in the name.

## Naming
Episodes follow Show Name - S01E02 so the scanner matches them. Extras go in a subfolder called Featurettes.

## Transcoding
The integrated GPU handles hardware transcoding for phones away from home.
`,
  ),
  note(
    'disc-ripping',
    'Ripping Blu-rays',
    'Home Lab',
    ['homelab', 'media'],
    '2026-10-05',
    `
An external Blu-ray drive is passed through to a container running the Automatic Ripping Machine.

## Workflow
Insert a disc and the machine identifies it, rips the main feature with MakeMKV, then HandBrake compresses it and files it in the movie library.

## Problems
A scratched disc can hang the drive. Unplug and plug the drive back in, then retry the job.
`,
  ),
  note(
    'home-assistant',
    'Home Assistant automations',
    'Home Lab',
    ['homelab', 'smart-home'],
    '2026-09-28',
    `
## Lighting
The porch and living room lamps turn on at sunset and off at eleven at night. Motion in the hallway after midnight turns on a dim night light.

## Climate
The thermostat drops to 66 degrees when everyone has left, based on phone presence.

## Alerts
A leak sensor under the sink sends a phone notification.
`,
  ),
  note(
    'zfs-snapshots',
    'ZFS snapshot schedule',
    'Home Lab',
    ['homelab', 'backup'],
    '2026-05-14',
    `
Sanoid takes snapshots of every dataset: hourly kept for two days, daily for a month, weekly for six months.

## Rolling back
A snapshot can be cloned to look inside it, or the dataset can be rolled back after a bad upgrade.
`,
  ),
  note(
    'network-vlans',
    'Network VLANs',
    'Home Lab',
    ['homelab', 'network'],
    '2026-04-02',
    `
The router splits the network into three VLANs: trusted laptops and phones, the IoT devices such as plugs, cameras and the television, and a guest wireless network.

## Firewall rules
IoT devices may reach the internet and Home Assistant only; they cannot open connections to the trusted VLAN.
`,
  ),
  note(
    'offsite-backup',
    'Offsite copy to Backblaze',
    'Home Lab',
    ['homelab', 'backup'],
    '2026-09-02',
    `
Restic copies the photo library and the virtual machine backups to a Backblaze B2 bucket every Sunday. The repository is encrypted with a key kept in the password manager.

## Restore test
Once a month, restore one random folder of pictures to a scratch disk and compare checksums.

## Cost
About two dollars a month for 400 GB.
`,
  ),
  note(
    'tailscale',
    'Remote access with Tailscale',
    'Home Lab',
    ['homelab', 'network'],
    '2026-03-19',
    `
Tailscale joins the laptop, the phone and the servers into one private mesh, so the dashboards open from a hotel or a coffee shop without opening router ports.

## Exit node
The home server can act as an exit node when travelling on untrusted wireless networks.
`,
  ),
  note(
    'homelab-power',
    'Power usage',
    'Home Lab',
    ['homelab', 'power'],
    '2026-02-11',
    `
The rack draws about 48 watts at idle: the mini PC, the switch, the router and the disk enclosure.

## What it costs
At 14 cents per kilowatt-hour that is roughly five dollars a month on the electricity bill.
`,
  ),
  note(
    'tomatoes',
    'Tomato plan',
    'Garden',
    ['garden'],
    '2026-02-20',
    `
Varieties this year: Sun Gold, Cherokee Purple and San Marzano for sauce.

## Seeds indoors
Sow seeds indoors under the grow light in mid February, two seeds per cell.

## Transplanting
Harden the seedlings off for a week and plant them in the beds after the last frost, usually late March here. Bury the stems deep and add cages right away.
`,
  ),
  note(
    'compost',
    'Compost bin',
    'Garden',
    ['garden'],
    '2026-06-08',
    `
Mix browns and greens about three to one: dry leaves and cardboard with kitchen scraps and grass clippings.

## Care
Turn the pile every two weeks and keep it as damp as a wrung-out sponge. Finished compost is dark and crumbly after about three months.
`,
  ),
  note(
    'raised-beds',
    'Raised beds',
    'Garden',
    ['garden'],
    '2026-01-25',
    `
Four cedar beds, each four by eight feet and a foot deep.

## Soil mix
Equal parts topsoil, compost and expanded shale, topped up each spring.

## Irrigation
Drip lines run along every bed from a timer on the hose bib.
`,
  ),
  note(
    'watering',
    'Watering schedule',
    'Garden',
    ['garden'],
    '2026-07-04',
    `
In summer the drip timer runs at six in the morning for twenty minutes, and a second time in the evening during heat waves above 100 degrees.

Container plants dry out fastest; check them by hand every day.
`,
  ),
  note(
    'pests',
    'Garden pests',
    'Garden',
    ['garden'],
    '2026-05-30',
    `
## Aphids
Blast them off with water, then spray insecticidal soap if they come back.

## Hornworms
Check the tomato plants at dusk for the big green caterpillars and pick them off.

## Squash vine borers
Wrap the base of the stems in foil early in the season.
`,
  ),
  note(
    'sourdough',
    'Sourdough starter',
    'Kitchen',
    ['cooking', 'baking'],
    '2026-08-17',
    `
The starter lives in the fridge between bakes.

## Feeding
Feed it equal weights of flour and water, one to one to one with the old starter, and leave it on the counter until it doubles.

## Levain
The night before baking, build a levain with whole wheat flour so it peaks in the morning.
`,
  ),
  note(
    'pizza-dough',
    'Neapolitan pizza dough',
    'Kitchen',
    ['cooking', 'baking'],
    '2026-09-06',
    `
## Recipe
1000 g 00 flour, 650 g water, 28 g salt and 2 g instant yeast: 65% hydration.

## Fermentation
Knead, rest for two hours, ball the dough and cold ferment in the fridge for two days.

## Baking
The outdoor oven needs to reach 450 °C on the stone; each pie bakes in ninety seconds.
`,
  ),
  note(
    'weeknight-meals',
    'Weeknight dinners',
    'Kitchen',
    ['cooking'],
    '2026-10-08',
    `
Quick dinners that take under thirty minutes: sheet pan chicken with vegetables, black bean tacos, fried rice with leftover rice, pasta with pesto and peas, and shakshuka.
`,
  ),
  note(
    'meal-prep',
    'Sunday meal prep',
    'Kitchen',
    ['cooking'],
    '2026-09-20',
    `
On Sunday afternoon, cook a big pot of rice, roast two trays of vegetables and grill chicken thighs. Portion everything into containers for lunches through Thursday.

## Storage
Glass containers keep four days in the fridge; freeze Friday's portion.
`,
  ),
  note(
    'coffee',
    'Pour-over coffee',
    'Kitchen',
    ['cooking'],
    '2026-03-03',
    `
## Ratio
Use 1:16 coffee to water: 20 g of beans for 320 g of water just off the boil.

## Method
Grind medium-fine, bloom with 40 g of water for thirty seconds, then pour in slow circles. The whole brew should take about three minutes.
`,
  ),
  note(
    'chili',
    'Smoked brisket chili',
    'Kitchen',
    ['cooking'],
    '2026-01-10',
    `
Leftover smoked brisket, two kinds of dried chiles, onions, garlic, cumin and a dark beer. Simmer for three hours and serve with cornbread.
`,
  ),
  note(
    'running-plan',
    'Half marathon training',
    'Health',
    ['fitness'],
    '2026-08-25',
    `
Twelve weeks to race day.

## Weekly runs
Three easy runs, one tempo run and a long run on Saturday that grows from 8 to 19 kilometres.

## Taper
Cut the mileage by a third in the last two weeks and sleep more.
`,
  ),
  note(
    'sleep',
    'Sleep routine',
    'Health',
    ['health'],
    '2026-07-15',
    `
Lights out at the same time every night, no screens for the last hour, and the bedroom kept cool and dark.

## What helps
Magnesium in the evening, no caffeine after noon, and a short walk outside in the morning light.
`,
  ),
  note(
    'physio',
    'Knee physiotherapy',
    'Health',
    ['health', 'fitness'],
    '2026-06-19',
    `
After the meniscus strain the physiotherapist set three exercises, twice a day:

## Exercises
- Straight leg raises, three sets of fifteen
- Wall sits, building up to a minute
- Step-downs from a low step, slowly
`,
  ),
  note(
    'doctor-visits',
    'Annual checkup notes',
    'Health',
    ['health'],
    '2026-04-28',
    `
Blood pressure 118 over 76. Cholesterol slightly high; recheck the lipid panel in six months. The doctor suggested more fibre and fewer fried foods.
`,
  ),
  note(
    'strength',
    'Strength training split',
    'Health',
    ['fitness'],
    '2026-05-05',
    `
Three days a week: squats and rows on Monday, bench press and pull-ups on Wednesday, deadlifts and overhead press on Friday. Add weight when all sets feel easy.
`,
  ),
  note(
    'budget',
    'Monthly budget',
    'Money',
    ['finance'],
    '2026-10-02',
    `
## Categories
Housing, groceries, transport, utilities, fun money and giving.

## Savings rate
Twenty percent of take-home pay goes to savings on payday before anything else.
`,
  ),
  note(
    'taxes-2026',
    'Tax return checklist',
    'Money',
    ['finance'],
    '2026-03-30',
    `
Gather before filing: W-2 forms, 1099 statements from the brokerage, mortgage interest form 1098, charitable donation receipts and last year's return.

## Deadline
File by April 15 or request an extension.
`,
  ),
  note(
    'emergency-fund',
    'Emergency fund',
    'Money',
    ['finance'],
    '2026-02-02',
    `
Six months of essential expenses in a high-yield savings account, kept apart from everyday checking. Only for a lost job, a medical bill or an urgent repair.
`,
  ),
  note(
    'subscriptions',
    'Subscriptions audit',
    'Money',
    ['finance'],
    '2026-08-09',
    `
Every six months list the recurring charges on the card statement: streaming services, apps, cloud storage, the gym. Anything not used in the last month gets cancelled.
`,
  ),
  note(
    'retirement',
    'Retirement accounts',
    'Money',
    ['finance'],
    '2026-01-18',
    `
Contribute enough to the 401(k) to get the full employer match, then max out a Roth IRA. Everything goes into broad index funds with low fees.
`,
  ),
  note(
    'insurance',
    'Home insurance renewal',
    'Money',
    ['finance', 'house'],
    '2026-06-01',
    `
The policy renews in July. Compare the deductible and the dwelling coverage with two other quotes, and ask about a discount for the monitored leak sensors.
`,
  ),
  note(
    'japan-trip',
    'Japan itinerary',
    'Travel',
    ['travel'],
    '2026-09-15',
    `
## Tokyo
Four days: Shibuya, the fish market, a day trip to Nikko.

## Kyoto
Three days of temples and gardens: Fushimi Inari at dawn, Kinkaku-ji, the bamboo grove in Arashiyama.

## Getting around
A seven-day rail pass covers the bullet train between the two cities.
`,
  ),
  note(
    'packing-list',
    'Packing list',
    'Travel',
    ['travel'],
    '2026-09-14',
    `
Carry-on only: three shirts, two trousers, a light rain jacket, a toiletry bag under 100 ml per bottle, chargers, a universal adapter and the passport.
`,
  ),
  note(
    'camping',
    'Camping gear',
    'Travel',
    ['travel', 'outdoors'],
    '2026-04-12',
    `
Tent for two, a sleeping bag rated to 20 °F, an inflatable pad, the small gas stove, a headlamp, a water filter and the bear canister for food.
`,
  ),
  note(
    'road-trip',
    'Hill Country road trip',
    'Travel',
    ['travel'],
    '2026-03-22',
    `
Drive to Fredericksburg for peaches and wineries, swim at Krause Springs, and stay two nights in a cabin near Wimberley.
`,
  ),
  note(
    'passport',
    'Passport renewal',
    'Travel',
    ['travel'],
    '2026-02-15',
    `
Renew by mail with form DS-82, a new photo and the old passport. Routine processing takes six to eight weeks, so start three months before any trip.
`,
  ),
  note(
    'meeting-notes-q3',
    'Q3 planning meeting',
    'Work',
    ['work'],
    '2026-07-01',
    `
## Priorities
Ship the mobile app beta, cut cloud spend by fifteen percent, and hire two engineers.

## Risks
The beta depends on the new authentication service, which is two weeks late.
`,
  ),
  note(
    'one-on-one',
    'One-on-one template',
    'Work',
    ['work'],
    '2026-05-20',
    `
- What went well since we last talked?
- What is blocking you?
- What would you like more feedback on?
- Career goals for the next six months
`,
  ),
  note(
    'incident-review',
    'Incident postmortem: database outage',
    'Work',
    ['work'],
    '2026-08-12',
    `
## Timeline
At 09:40 the primary database ran out of disk. Writes failed for 47 minutes until the old logs were removed and the replica was promoted.

## Root cause
Log rotation had been disabled during a migration and never turned back on.

## Action items
Alert at 80% disk usage and add log rotation to the deployment checklist.
`,
  ),
  note(
    'hiring',
    'Interview loop',
    'Work',
    ['work'],
    '2026-06-11',
    `
Four interviews: a coding exercise, system design, a conversation about past projects, and a values interview. Each interviewer writes feedback before the debrief.
`,
  ),
  note(
    'okrs',
    'Team OKRs',
    'Work',
    ['work'],
    '2026-06-28',
    `
Objective: make the app feel instant. Key results: median page load under one second, crash-free sessions above 99.5%, and support tickets about slowness down by half.
`,
  ),
  note(
    'code-review',
    'Code review guidelines',
    'Work',
    ['work'],
    '2026-04-07',
    `
Review within one working day. Comment on behaviour and risk before style. Approve with suggestions when nothing blocks the merge.
`,
  ),
  note(
    'deep-work',
    'Deep Work by Cal Newport',
    'Reading',
    ['books'],
    '2026-02-27',
    `
Focused, uninterrupted effort produces the valuable work; shallow tasks like email expand to fill the day.

## Practices
Schedule long blocks with notifications off, batch messages twice a day, and keep a shutdown ritual at the end of work.
`,
  ),
  note(
    'atomic-habits',
    'Atomic Habits',
    'Reading',
    ['books'],
    '2026-01-30',
    `
Small changes compound. Make the cue obvious, the action easy and the reward satisfying.

## Habit stacking
Attach a new habit to an existing one: after pouring the morning coffee, write three lines in the journal.
`,
  ),
  note(
    'sapiens',
    'Sapiens',
    'Reading',
    ['books'],
    '2026-03-11',
    `
Shared myths such as money, nations and companies let large groups of strangers cooperate. The agricultural revolution traded freedom for food security.
`,
  ),
  note(
    'reading-list',
    'Books to read',
    'Reading',
    ['books'],
    '2026-10-10',
    `
- The Pragmatic Programmer
- Project Hail Mary
- Four Thousand Weeks
- The Making of the Atomic Bomb
`,
  ),
  note(
    'dune',
    'Dune',
    'Reading',
    ['books'],
    '2026-05-25',
    `
Paul Atreides on the desert planet Arrakis; spice, sandworms and the Fremen. Politics and ecology carry as much of the story as the battles.
`,
  ),
  note(
    'car-maintenance',
    'Car maintenance log',
    'Home',
    ['car'],
    '2026-09-30',
    `
## Oil
Synthetic oil changed at 45,000 miles; next at 52,500.

## Tyres
Rotated and balanced in September. The front left loses pressure slowly; check for a nail.
`,
  ),
  note(
    'hvac',
    'HVAC filter and AC service',
    'Home',
    ['house'],
    '2026-05-09',
    `
Replace the 20x25 furnace filter every three months. The air conditioner gets a service visit each April before the heat arrives.
`,
  ),
  note(
    'move-checklist',
    'Moving checklist',
    'Home',
    ['house'],
    '2026-01-05',
    `
Forward the mail, transfer utilities, update the address with the bank and the DMV, and book the movers four weeks ahead.
`,
  ),
  note(
    'dog-care',
    'Dog care',
    'Home',
    ['pets'],
    '2026-07-27',
    `
Biscuit gets two cups of kibble a day. Vaccines are due in March; heartworm pills on the first of each month. The vet is on Oak Street.
`,
  ),
  note(
    'gift-ideas',
    'Gift ideas',
    'Home',
    ['family'],
    '2026-10-12',
    `
- Mum: a pottery class
- Dad: the new edition of his favourite atlas
- Sam: climbing shoes
- Anniversary: a weekend away in a cabin
`,
  ),
  note(
    'journal-2026-10-01',
    '2026-10-01',
    'Journal',
    ['journal'],
    '2026-10-01',
    `
Ran five miles before work and felt strong. Fixed the router after it dropped the guest network again. Dinner with friends.
`,
  ),
  note(
    'weekly-review',
    'Weekly review template',
    'Journal',
    ['journal'],
    '2026-04-19',
    `
## Look back
What got done, what slipped, what I learned.

## Look ahead
The three most important tasks for next week, and appointments on the calendar.
`,
  ),
  note(
    'goals-2026',
    'Goals for 2026',
    'Journal',
    ['journal'],
    '2026-01-01',
    `
Run a half marathon, read twenty-four books, cook dinner at home five nights a week, and keep the savings rate at twenty percent.
`,
  ),
  note(
    'app-ideas',
    'App ideas',
    'Journal',
    ['ideas'],
    '2026-08-30',
    `
A notes app that works offline, searches everything instantly and lets agents edit through a command line. A plant watering reminder that reads the weather forecast.
`,
  ),
];
