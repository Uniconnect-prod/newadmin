import { countryRepository } from '../repositories/countryRepository.js';
import { logAudit } from '../middleware/auditLogger.js';
import { badRequest, notFound, conflict } from '../utils/errors.js';

function isValidTimezone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function validate(body, partial) {
  const out = {};
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.length > 80) {
      throw badRequest('Country name is required (2–80 characters).');
    }
    out.name = body.name.trim();
  }
  if (!partial || body.code !== undefined) {
    if (typeof body.code !== 'string' || !/^[A-Za-z]{2,3}$/.test(body.code.trim())) {
      throw badRequest('Country code must be a 2–3 letter ISO code (e.g. GH).');
    }
    out.code = body.code.trim().toUpperCase();
  }
  if (body.currency !== undefined) {
    if (typeof body.currency !== 'string' || !/^[A-Za-z]{3}$/.test(body.currency.trim())) {
      throw badRequest('Currency must be a 3-letter ISO code (e.g. GHS).');
    }
    out.currency = body.currency.trim().toUpperCase();
  }
  if (body.default_timezone !== undefined) {
    if (typeof body.default_timezone !== 'string' || !isValidTimezone(body.default_timezone.trim())) {
      throw badRequest('Timezone must be a valid IANA timezone (e.g. Africa/Accra).');
    }
    out.default_timezone = body.default_timezone.trim();
  }
  if (body.status !== undefined) {
    out.status = body.status === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
  }
  return out;
}

export const countryController = {
  async getAllCountries(req, res) {
    const { search, status } = req.query;
    const data = await countryRepository.listAll({ search, status });
    res.json({ success: true, data });
  },

  async getCountryById(req, res) {
    const c = await countryRepository.findById(req.params.id);
    if (!c) throw notFound('Country not found.');
    res.json({ success: true, data: c });
  },

  async createCountry(req, res) {
    const data = validate(req.body || {}, false);
    const dup = await countryRepository.findByNameOrCode(data.name, data.code);
    if (dup) throw conflict(`Country '${data.name}' or code '${data.code}' already exists.`);
    
    const created = await countryRepository.create(data);
    await logAudit(req, 'CREATE_COUNTRY', 'Country', created.id, { name: created.name, code: created.code }, { platformId: null });
    res.status(201).json({ success: true, message: `Country '${created.name}' created.`, data: created });
  },

  async updateCountry(req, res) {
    const id = parseInt(req.params.id, 10);
    const existing = await countryRepository.findById(id);
    if (!existing) throw notFound('Country not found.');
    
    const data = validate(req.body || {}, true);
    if (data.name || data.code) {
      const dup = await countryRepository.findByNameOrCode(data.name || existing.name, data.code || existing.code, id);
      if (dup) throw conflict(`Country '${data.name || existing.name}' or code '${data.code || existing.code}' is already used.`);
    }

    const updated = await countryRepository.update(id, data);
    await logAudit(req, 'UPDATE_COUNTRY', 'Country', id, data, { platformId: null });
    res.json({ success: true, message: 'Country updated.', data: updated });
  },

  async deleteCountry(req, res) {
    const id = parseInt(req.params.id, 10);
    const existing = await countryRepository.findById(id);
    if (!existing) throw notFound('Country not found.');
    
    if (existing.platformCount > 0) {
      await countryRepository.deactivate(id);
      await logAudit(req, 'DEACTIVATE_COUNTRY', 'Country', id, { linkedPlatforms: existing.platformCount }, { platformId: null });
      return res.json({ success: true, message: `'${existing.name}' has ${existing.platformCount} linked platform(s), so it was deactivated instead of deleted.` });
    }
    
    await countryRepository.delete(id);
    await logAudit(req, 'DELETE_COUNTRY', 'Country', id, { name: existing.name }, { platformId: null });
    res.json({ success: true, message: `'${existing.name}' deleted.` });
  }
};
