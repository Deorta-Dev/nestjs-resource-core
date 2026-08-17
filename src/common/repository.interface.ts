import { Observable } from 'rxjs';

export interface FilterQuery<T = any> {
  [key: string]: any;
}

export interface IBaseRepositoryService<T = any> {
  find(query?: FilterQuery<T>, options?: any): Observable<T[]>;
  findOne(query: FilterQuery<T>, options?: any): Observable<T | null>;
  create(data: any): Observable<T>;
  update(id: string | any, data: any): Observable<T>;
  delete(id: string | any): Observable<void>;
  count(query?: FilterQuery<T>): Observable<number>;
  aggregate?(pipeline: any[]): Observable<any[]>;
  upsert?(query: FilterQuery<T>, data: any): Observable<T>;
}
