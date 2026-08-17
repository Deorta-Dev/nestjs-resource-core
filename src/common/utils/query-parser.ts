import { FilterQuery } from '../repository.interface';

export function parseQueryMatchDirectory(queryParams: any, directory: any): FilterQuery {
  const $and: any[] = [];

  for (const [key, config] of Object.entries(directory)) {
    const value = queryParams[key];
    if (value === undefined || value === null) {
      if ((config as any).require) {
        throw new Error(`Missing required query parameter: ${key}`);
      }
      continue;
    }

    const conf = config as any;
    if (conf.expr) {
      $and.push(conf.expr(value));
      continue;
    }

    const attr = conf.attribute || key;
    let typedValue = value;
    
    // Basic casting
    if (conf.type === 'number') typedValue = Number(value);
    if (conf.type === 'boolean') typedValue = value === 'true' || value === '1';
    if (conf.type === 'date') typedValue = new Date(value as string);

    let match = {};
    switch (conf.operation) {
      case 'eq': match = { [attr]: { $eq: typedValue } }; break;
      case 'ne': match = { [attr]: { $ne: typedValue } }; break;
      case 'gt': match = { [attr]: { $gt: typedValue } }; break;
      case 'gte': match = { [attr]: { $gte: typedValue } }; break;
      case 'lt': match = { [attr]: { $lt: typedValue } }; break;
      case 'lte': match = { [attr]: { $lte: typedValue } }; break;
      case 'in': match = { [attr]: { $in: Array.isArray(typedValue) ? typedValue : [typedValue] } }; break;
      case 'regex': match = { [attr]: { $regex: typedValue, $options: 'i' } }; break;
      default: match = { [attr]: typedValue };
    }
    $and.push(match);
  }

  return $and.length > 0 ? { $and } : {};
}
