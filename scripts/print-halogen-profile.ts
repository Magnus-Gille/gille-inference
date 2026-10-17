#!/usr/bin/env tsx
import { HALOGEN_PILOT_PROFILE, halogenEnvironment, halogenProfileHash, halogenProfileSchema } from '../src/homeserver/halogen-profile.js';
const args = process.argv.slice(2);
if (args.length !== 0) throw new Error('print-halogen-profile accepts no arguments; profile changes require a reviewed revision');
const profile = halogenProfileSchema.parse(HALOGEN_PILOT_PROFILE);
console.log(JSON.stringify({ profile, profileSha256: halogenProfileHash(profile), environment: halogenEnvironment(profile) }, null, 2));
