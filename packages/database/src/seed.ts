import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';
import { eq } from 'drizzle-orm';

const LOCATIONS = [
  {
    name: 'Town Square',
    slug: 'town-square',
    description: 'The central hub of New Concord. Merchants, gossip, and politics converge here.',
    connections: ['tavern', 'market', 'city-hall', 'residential-district'],
  },
  {
    name: 'Tavern',
    slug: 'tavern',
    description: 'The Rusty Anchor tavern — where deals are made and secrets are shared over ale.',
    connections: ['town-square', 'residential-district'],
  },
  {
    name: 'Market',
    slug: 'market',
    description: 'The open-air market where goods and currency change hands daily.',
    connections: ['town-square', 'warehouse-district', 'farm'],
  },
  {
    name: 'City Hall',
    slug: 'city-hall',
    description: 'Seat of local government. The mayor and council govern here.',
    connections: ['town-square', 'guard-station', 'bank'],
  },
  {
    name: 'Bank',
    slug: 'bank',
    description: 'New Concord Savings — where the wealthy store their gold and the desperate beg for loans.',
    connections: ['city-hall', 'market'],
  },
  {
    name: 'Farm',
    slug: 'farm',
    description: 'The fertile fields on the edge of town. Food production happens here.',
    connections: ['market', 'warehouse-district'],
  },
  {
    name: 'Mine',
    slug: 'mine',
    description: 'The iron mine north of town. Hard work, scarce ore, and dangerous conditions.',
    connections: ['warehouse-district', 'guard-station'],
  },
  {
    name: 'Warehouse District',
    slug: 'warehouse-district',
    description: 'Goods flow through here. Whoever controls the warehouses controls trade.',
    connections: ['market', 'farm', 'mine', 'residential-district'],
  },
  {
    name: 'Residential District',
    slug: 'residential-district',
    description: 'Where most citizens sleep, raise families, and organize.',
    connections: ['town-square', 'tavern', 'warehouse-district'],
  },
  {
    name: 'Guard Station',
    slug: 'guard-station',
    description: 'Law enforcement headquarters. The line between order and oppression.',
    connections: ['city-hall', 'mine', 'residential-district'],
  },
];

const CHARACTERS = [
  {
    name: 'Marcus Aldren',
    age: 45,
    background: 'Former merchant who built a small fortune through shrewd deals. Now seeks the mayor\'s seat to legitimize his influence.',
    personalityTraits: [{ trait: 'ambitious', weight: 0.9 }, { trait: 'manipulative', weight: 0.6 }, { trait: 'greedy', weight: 0.5 }],
    skills: ['negotiation', 'accounting', 'persuasion'],
    ambitions: ['become mayor', 'control trade routes', 'build a merchant empire'],
    archetype: 'mayor-seeker',
    startingLocation: 'city-hall',
  },
  {
    name: 'Elena Voss',
    age: 38,
    background: 'Mine foreman\'s daughter who watched iron profits flow away from workers. Determined to change that.',
    personalityTraits: [{ trait: 'ambitious', weight: 0.7 }, { trait: 'loyal', weight: 0.8 }, { trait: 'brave', weight: 0.7 }],
    skills: ['mining', 'organizing', 'public speaking'],
    ambitions: ['organize workers', 'secure fair wages', 'expose corporate corruption'],
    archetype: 'workers-coalition-organizer',
    startingLocation: 'mine',
  },
  {
    name: 'Brother Tomlin',
    age: 55,
    background: 'Retired guard captain who now runs a community shelter. Believes in order through compassion.',
    personalityTraits: [{ trait: 'compassionate', weight: 0.9 }, { trait: 'honest', weight: 0.85 }, { trait: 'loyal', weight: 0.7 }],
    skills: ['mediation', 'combat', 'leadership'],
    ambitions: ['keep the peace', 'protect the vulnerable', 'prevent civil unrest'],
    archetype: 'peacekeeper',
    startingLocation: 'guard-station',
  },
  {
    name: 'Sera Nighthollow',
    age: 29,
    background: 'Former smuggler with a network of underground contacts. Has ambitions beyond mere theft.',
    personalityTraits: [{ trait: 'manipulative', weight: 0.8 }, { trait: 'impulsive', weight: 0.6 }, { trait: 'ambitious', weight: 0.75 }],
    skills: ['stealth', 'negotiation', 'intimidation'],
    ambitions: ['found a criminal organization', 'control black market', 'become untouchable'],
    archetype: 'criminal-org-founder',
    startingLocation: 'tavern',
  },
  {
    name: 'Aldous Crane',
    age: 62,
    background: 'Retired journalist with a lifetime of evidence about corruption in New Concord. Writing his exposé.',
    personalityTraits: [{ trait: 'honest', weight: 0.95 }, { trait: 'paranoid', weight: 0.6 }, { trait: 'brave', weight: 0.65 }],
    skills: ['investigation', 'writing', 'networking'],
    ambitions: ['expose corruption', 'protect press freedom', 'see justice done'],
    archetype: 'corruption-exposer',
    startingLocation: 'tavern',
  },
  {
    name: 'Gordan Ironstrike',
    age: 41,
    background: 'Born in the mine, worked every job. Now wants to own the operation.',
    personalityTraits: [{ trait: 'greedy', weight: 0.7 }, { trait: 'ambitious', weight: 0.8 }, { trait: 'cautious', weight: 0.6 }],
    skills: ['mining', 'trading', 'logistics'],
    ambitions: ['control iron trade', 'monopolize ore production', 'corner the market'],
    archetype: 'iron-trade-controller',
    startingLocation: 'mine',
  },
  {
    name: 'Lady Vivienne Starre',
    age: 34,
    background: 'Noble from the capital who relocated to New Concord for "the air." Actually here to build influence.',
    personalityTraits: [{ trait: 'sociable', weight: 0.95 }, { trait: 'manipulative', weight: 0.7 }, { trait: 'ambitious', weight: 0.65 }],
    skills: ['charm', 'etiquette', 'gossip', 'networking'],
    ambitions: ['become the social center of New Concord', 'broker political marriages', 'gather influence'],
    archetype: 'socialite',
    startingLocation: 'town-square',
  },
  {
    name: 'Captain Renfield',
    age: 48,
    background: 'Current head of the guard. Loyal to the existing government and its institutions.',
    personalityTraits: [{ trait: 'loyal', weight: 0.9 }, { trait: 'honest', weight: 0.75 }, { trait: 'cautious', weight: 0.8 }],
    skills: ['law enforcement', 'tactics', 'investigation'],
    ambitions: ['maintain order', 'protect the government', 'advance through the ranks'],
    archetype: 'government-protector',
    startingLocation: 'guard-station',
  },
  {
    name: 'Pell the Agitator',
    age: 31,
    background: 'Street-level provocateur who genuinely believes the current system must burn to rebuild.',
    personalityTraits: [{ trait: 'impulsive', weight: 0.8 }, { trait: 'brave', weight: 0.75 }, { trait: 'vengeful', weight: 0.65 }],
    skills: ['rhetoric', 'crowd-management', 'underground networking'],
    ambitions: ['destabilize the government', 'spark revolution', 'tear down old power'],
    archetype: 'government-destabilizer',
    startingLocation: 'residential-district',
  },
  {
    name: 'Farmer Doris Helm',
    age: 52,
    background: 'Third-generation farmer struggling with drought. Needs political allies to survive.',
    personalityTraits: [{ trait: 'loyal', weight: 0.7 }, { trait: 'cautious', weight: 0.75 }, { trait: 'honest', weight: 0.85 }],
    skills: ['farming', 'weather-reading', 'bartering'],
    ambitions: ['secure water rights', 'protect the farm', 'build wealth slowly'],
    archetype: 'wealth-seeker',
    startingLocation: 'farm',
  },
  {
    name: 'Tomas Brightwater',
    age: 27,
    background: 'Young banker\'s apprentice with mathematical genius and no morals to speak of.',
    personalityTraits: [{ trait: 'greedy', weight: 0.85 }, { trait: 'ambitious', weight: 0.8 }, { trait: 'cautious', weight: 0.7 }],
    skills: ['accounting', 'finance', 'risk analysis'],
    ambitions: ['accumulate wealth', 'control banking', 'finance political campaigns'],
    archetype: 'wealth-seeker',
    startingLocation: 'bank',
  },
  {
    name: 'Mira Crossbow',
    age: 36,
    background: 'Merchant with connections to both sides of the law. Pragmatic to a fault.',
    personalityTraits: [{ trait: 'greedy', weight: 0.65 }, { trait: 'cautious', weight: 0.8 }, { trait: 'sociable', weight: 0.7 }],
    skills: ['trade', 'negotiation', 'supply chains'],
    ambitions: ['become the wealthiest merchant', 'secure exclusive contracts', 'outlast all rivals'],
    archetype: 'wealth-seeker',
    startingLocation: 'market',
  },
  {
    name: 'Old Gregor',
    age: 71,
    background: 'Former mayor who lost power 10 years ago and has been scheming for a return ever since.',
    personalityTraits: [{ trait: 'manipulative', weight: 0.85 }, { trait: 'vengeful', weight: 0.75 }, { trait: 'ambitious', weight: 0.7 }],
    skills: ['politics', 'leverage', 'long-term planning'],
    ambitions: ['reclaim the mayorship', 'punish those who betrayed him', 'reshape New Concord'],
    archetype: 'mayor-seeker',
    startingLocation: 'town-square',
  },
  {
    name: 'Nadia Folkstone',
    age: 33,
    background: 'Warehouse district manager who controls what comes in and goes out. Knowledge is power.',
    personalityTraits: [{ trait: 'cautious', weight: 0.8 }, { trait: 'greedy', weight: 0.6 }, { trait: 'loyal', weight: 0.65 }],
    skills: ['logistics', 'inventory', 'intelligence gathering'],
    ambitions: ['control the flow of goods', 'build a spy network', 'become indispensable'],
    archetype: 'iron-trade-controller',
    startingLocation: 'warehouse-district',
  },
  {
    name: 'Father Cedric',
    age: 58,
    background: 'Community leader who mediates disputes and maintains a network of grateful contacts.',
    personalityTraits: [{ trait: 'compassionate', weight: 0.9 }, { trait: 'sociable', weight: 0.8 }, { trait: 'honest', weight: 0.8 }],
    skills: ['mediation', 'counseling', 'community organizing'],
    ambitions: ['unite the community', 'prevent violence', 'create lasting peace'],
    archetype: 'peacekeeper',
    startingLocation: 'residential-district',
  },
  {
    name: 'Zara the Fence',
    age: 24,
    background: 'Young criminal entrepreneur who moves stolen goods and information with equal ease.',
    personalityTraits: [{ trait: 'manipulative', weight: 0.75 }, { trait: 'impulsive', weight: 0.7 }, { trait: 'sociable', weight: 0.65 }],
    skills: ['black market', 'appraisal', 'social engineering'],
    ambitions: ['build criminal empire', 'stay ahead of the law', 'become rich'],
    archetype: 'criminal-org-founder',
    startingLocation: 'tavern',
  },
  {
    name: 'Henrik Stonewall',
    age: 44,
    background: 'Union organizer blacklisted from the mine. Now operates underground.',
    personalityTraits: [{ trait: 'loyal', weight: 0.85 }, { trait: 'brave', weight: 0.8 }, { trait: 'honest', weight: 0.75 }],
    skills: ['organizing', 'strategy', 'underground networks'],
    ambitions: ['workers revolution', 'economic justice', 'tear down inequality'],
    archetype: 'workers-coalition-organizer',
    startingLocation: 'residential-district',
  },
  {
    name: 'Councilor Maren Ashby',
    age: 51,
    background: 'Sitting city council member. Positions herself as reasonable while quietly hoarding power.',
    personalityTraits: [{ trait: 'ambitious', weight: 0.75 }, { trait: 'cautious', weight: 0.85 }, { trait: 'manipulative', weight: 0.65 }],
    skills: ['law', 'negotiation', 'political maneuvering'],
    ambitions: ['become mayor', 'outlast rivals through attrition', 'build loyal coalition'],
    archetype: 'mayor-seeker',
    startingLocation: 'city-hall',
  },
  {
    name: 'Pip the Runner',
    age: 19,
    background: 'Street kid who runs messages for anyone who pays. Knows every secret alley and every face.',
    personalityTraits: [{ trait: 'impulsive', weight: 0.7 }, { trait: 'sociable', weight: 0.8 }, { trait: 'cautious', weight: 0.4 }],
    skills: ['speed', 'navigation', 'observation'],
    ambitions: ['get rich quick', 'stay alive', 'find a patron'],
    archetype: 'wealth-seeker',
    startingLocation: 'town-square',
  },
  {
    name: 'Director Halvard Stone',
    age: 63,
    background: 'Head of the New Concord Merchant Association. Has kept the government stable for decades.',
    personalityTraits: [{ trait: 'loyal', weight: 0.8 }, { trait: 'cautious', weight: 0.9 }, { trait: 'greedy', weight: 0.6 }],
    skills: ['administration', 'coalition building', 'trade policy'],
    ambitions: ['maintain stability', 'protect merchant interests', 'prevent radical change'],
    archetype: 'government-protector',
    startingLocation: 'city-hall',
  },
];

async function seed() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');

  const client = postgres(url, { max: 1 });
  const db = drizzle(client, { schema });

  console.log('Seeding locations...');
  const locationMap: Record<string, string> = {};

  for (const loc of LOCATIONS) {
    const existing = await db
      .select()
      .from(schema.locations)
      .where(eq(schema.locations.slug, loc.slug))
      .limit(1);

    let locationId: string;
    if (existing.length > 0) {
      locationId = existing[0].id;
    } else {
      const [inserted] = await db
        .insert(schema.locations)
        .values({
          name: loc.name,
          slug: loc.slug,
          description: loc.description,
          connections: loc.connections,
        })
        .returning({ id: schema.locations.id });
      locationId = inserted.id;
    }
    locationMap[loc.slug] = locationId;
    console.log(`  Location: ${loc.name} (${locationId})`);
  }

  console.log('Seeding characters...');
  for (const char of CHARACTERS) {
    const existing = await db
      .select()
      .from(schema.characters)
      .where(eq(schema.characters.name, char.name))
      .limit(1);

    let characterId: string;
    if (existing.length > 0) {
      characterId = existing[0].id;
      console.log(`  Character exists: ${char.name}`);
    } else {
      const [inserted] = await db
        .insert(schema.characters)
        .values({
          name: char.name,
          age: char.age,
          background: char.background,
          personalityTraits: char.personalityTraits,
          skills: char.skills,
          ambitions: char.ambitions,
          archetype: char.archetype,
        })
        .returning({ id: schema.characters.id });
      characterId = inserted.id;

      // Character state
      const locationId = locationMap[char.startingLocation];
      await db.insert(schema.characterState).values({
        characterId,
        locationId,
        health: 100,
        fatigue: 0,
        status: 'idle',
      });

      // Wallet
      await db.insert(schema.wallets).values({
        characterId,
        balanceCents: 10000, // DEFAULT_STARTING_CURRENCY_CENTS
      });

      console.log(`  Character: ${char.name} at ${char.startingLocation}`);
    }
  }

  console.log('Seed complete!');
  await client.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
