"use strict";

const seedData = require("../data/seed.json");
const { createVercelHandler } = require("../server");

module.exports = createVercelHandler({ seedData });