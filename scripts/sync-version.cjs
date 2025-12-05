#!/usr/bin/env node
// Script to sync version from pyproject.toml to package.json

const fs = require('fs');
const path = require('path');

// Read pyproject.toml
const pyprojectPath = path.join(__dirname, '..', 'pyproject.toml');
const pyprojectContent = fs.readFileSync(pyprojectPath, 'utf8');

// Extract version from pyproject.toml
const versionMatch = pyprojectContent.match(/^version\s*=\s*"([^"]+)"/m);
if (!versionMatch) {
  console.error('Could not find version in pyproject.toml');
  process.exit(1);
}

const version = versionMatch[1];
console.log(`Found version ${version} in pyproject.toml`);

// Read package.json
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

// Update version
packageJson.version = version;

// Write package.json
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
console.log(`Updated package.json to version ${version}`);
