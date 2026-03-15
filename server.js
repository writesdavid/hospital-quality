const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = 3003;

// 30-minute in-memory cache
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

// Fetch with 10s timeout
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

// POST to CMS datastore with filters
async function cmsQuery(resourceId, filters, limit = 10, offset = 0) {
  const url = `https://data.cms.gov/provider-data/api/1/datastore/query/${resourceId}/0`;
  const body = {
    limit,
    offset,
    filters,
    sort: [],
    keys: true
  };
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`CMS API error: ${res.status}`);
  return res.json();
}

// Search hospitals by name or zip
async function searchHospitals(query) {
  const cacheKey = `search:${query}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const isZip = /^\d{5}$/.test(query.trim());

  let filters;
  if (isZip) {
    filters = [{ resource: 'xubh-q36u', type: 'contains', property: 'zip_code', value: query.trim() }];
  } else {
    filters = [{ resource: 'xubh-q36u', type: 'contains', property: 'hospital_name', value: query.trim() }];
  }

  try {
    const data = await cmsQuery('xubh-q36u', filters, 10, 0);
    const results = (data.results || data.data || []).map(h => ({
      provider_id: h.provider_id || h.facility_id,
      hospital_name: h.hospital_name || h.facility_name,
      city: h.city,
      state: h.state,
      zip_code: h.zip_code,
      overall_rating: h.hospital_overall_rating || h.overall_rating,
      hospital_type: h.hospital_type,
      phone_number: h.phone_number
    }));
    setCache(cacheKey, results);
    return results;
  } catch (err) {
    // Fallback: try GET with keyword
    const url = `https://data.cms.gov/provider-data/api/1/datastore/query/xubh-q36u/0?keyword=${encodeURIComponent(query)}&limit=10`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`Search failed: ${res.status}`);
    const data = await res.json();
    const results = (data.results || data.data || []).map(h => ({
      provider_id: h.provider_id || h.facility_id,
      hospital_name: h.hospital_name || h.facility_name,
      city: h.city,
      state: h.state,
      zip_code: h.zip_code,
      overall_rating: h.hospital_overall_rating || h.overall_rating,
      hospital_type: h.hospital_type,
      phone_number: h.phone_number
    }));
    setCache(cacheKey, results);
    return results;
  }
}

// Fetch complications/deaths (mortality) for a provider
async function fetchMortality(providerId) {
  const filters = [{ resource: 'ynj2-r877', type: 'exact', property: 'facility_id', value: providerId }];
  try {
    const data = await cmsQuery('ynj2-r877', filters, 50, 0);
    return data.results || data.data || [];
  } catch {
    return [];
  }
}

// Fetch readmissions for a provider
async function fetchReadmissions(providerId) {
  const filters = [{ resource: '632h-zaca', type: 'exact', property: 'facility_id', value: providerId }];
  try {
    const data = await cmsQuery('632h-zaca', filters, 50, 0);
    return data.results || data.data || [];
  } catch {
    return [];
  }
}

// Fetch patient experience (HCAHPS) for a provider
async function fetchPatientExperience(providerId) {
  const filters = [{ resource: 'dgck-syfz', type: 'exact', property: 'facility_id', value: providerId }];
  try {
    const data = await cmsQuery('dgck-syfz', filters, 50, 0);
    return data.results || data.data || [];
  } catch {
    return [];
  }
}

// Fetch hospital general info by provider_id
async function fetchHospitalInfo(providerId) {
  const filters = [{ resource: 'xubh-q36u', type: 'exact', property: 'provider_id', value: providerId }];
  try {
    const data = await cmsQuery('xubh-q36u', filters, 1, 0);
    const results = data.results || data.data || [];
    return results[0] || null;
  } catch {
    return null;
  }
}

// Map comparison text to normalized value
function normalizeComparison(val) {
  if (!val) return null;
  const v = val.toString().toLowerCase();
  if (v.includes('better')) return 'better';
  if (v.includes('worse')) return 'worse';
  if (v.includes('same') || v.includes('no different')) return 'same';
  if (v.includes('not available') || v.includes('n/a')) return null;
  return 'same';
}

// Routes
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Query required' });

  try {
    const results = await searchHospitals(q);
    res.json({ results });
  } catch (err) {
    console.error('Search error:', err.message);
    res.status(500).json({ error: 'Search failed', detail: err.message });
  }
});

app.get('/api/hospital/:providerId', async (req, res) => {
  const { providerId } = req.params;
  const cacheKey = `hospital:${providerId}`;
  const cached = getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [info, mortalityRaw, readmissionsRaw, experienceRaw] = await Promise.all([
      fetchHospitalInfo(providerId),
      fetchMortality(providerId),
      fetchReadmissions(providerId),
      fetchPatientExperience(providerId)
    ]);

    // Process mortality measures — pick key ones
    const mortalityMeasures = mortalityRaw
      .filter(m => {
        const name = (m.measure_name || m.measure_id || '').toLowerCase();
        return name.includes('mortality') || name.includes('death');
      })
      .map(m => ({
        measure_id: m.measure_id,
        measure_name: m.measure_name,
        score: m.score,
        comparison: normalizeComparison(m.compared_to_national || m.comparison),
        footnote: m.footnote
      }));

    // Process readmission measures
    const readmissionMeasures = readmissionsRaw
      .filter(m => {
        const name = (m.measure_name || m.measure_id || '').toLowerCase();
        return name.includes('readmission') || name.includes('return');
      })
      .map(m => ({
        measure_id: m.measure_id,
        measure_name: m.measure_name,
        score: m.score,
        comparison: normalizeComparison(m.compared_to_national || m.comparison),
        footnote: m.footnote
      }));

    // Process patient experience (HCAHPS summary)
    const experienceMeasures = experienceRaw
      .filter(m => {
        const name = (m.hcahps_measure_id || m.measure_id || '').toLowerCase();
        return name.includes('summary') || name.includes('overall') || name.includes('linear');
      })
      .map(m => ({
        measure_id: m.hcahps_measure_id || m.measure_id,
        measure_name: m.hcahps_question || m.measure_name,
        score: m.patient_survey_star_rating || m.hcahps_answer_percent || m.score,
        comparison: normalizeComparison(m.patient_survey_star_rating_footnote || m.compared_to_national),
        footnote: m.footnote
      }));

    const result = {
      provider_id: providerId,
      hospital_name: info ? (info.hospital_name || info.facility_name) : null,
      city: info ? info.city : null,
      state: info ? info.state : null,
      zip_code: info ? info.zip_code : null,
      phone_number: info ? info.phone_number : null,
      hospital_type: info ? info.hospital_type : null,
      overall_rating: info ? (info.hospital_overall_rating || info.overall_rating) : null,
      mortality: mortalityMeasures,
      readmissions: readmissionMeasures,
      patient_experience: experienceMeasures,
      // Also include raw for UI fallback
      mortality_raw: mortalityRaw.slice(0, 10),
      readmissions_raw: readmissionsRaw.slice(0, 10),
      experience_raw: experienceRaw.slice(0, 10)
    };

    setCache(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Hospital fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch hospital data', detail: err.message });
  }
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Hospital Quality server running on port ${PORT}`);
  });
}
