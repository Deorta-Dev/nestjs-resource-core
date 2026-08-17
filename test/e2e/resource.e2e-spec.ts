import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Module, Injectable } from '@nestjs/common';
import * as request from 'supertest';
import { AuthResourceApiModule, ResourceApiModule, IBaseRepositoryService } from '../../src';
import { Observable, of } from 'rxjs';

@Injectable()
class MockMobileRepo implements IBaseRepositoryService {
  private data: any[] = [];
  
  find(): Observable<any[]> {
    return of([...this.data]);
  }
  findOne(query: any): Observable<any | null> {
    return of(this.data[0] || null);
  }
  create(data: any): Observable<any> {
    const item = { id: Math.random().toString(), ...data };
    this.data.push(item);
    return of(item);
  }
  update(id: string, data: any): Observable<any> {
    return of({ id, ...data });
  }
  delete(id: string): Observable<void> {
    return of(undefined);
  }
  count(): Observable<number> {
    return of(this.data.length);
  }
}

@Module({
  providers: [MockMobileRepo],
  exports: [MockMobileRepo],
})
class MockRepoModule {}

describe('ResourceApiModule (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        AuthResourceApiModule.register({
          default: 'jwt',
          strategies: {
            jwt: { type: 'jwt' }
          },
          publicResources: [
            { route: 'GET /mobiles/public' }
          ]
        }),
        ResourceApiModule.register({
          name: 'mobile',
          route: 'mobiles',
          entity: {},
          repositoryModule: MockRepoModule,
          repositoryService: MockMobileRepo,
        }),
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /mobiles should return 401 without token', () => {
    return request(app.getHttpServer())
      .get('/mobiles')
      .expect(401);
  });

  it('GET /mobiles should return 200 with valid token', () => {
    return request(app.getHttpServer())
      .get('/mobiles')
      .set('Authorization', 'Bearer valid-token')
      .expect(200)
      .expect([]);
  });

  it('POST /mobiles should return 201 with valid token', () => {
    return request(app.getHttpServer())
      .post('/mobiles')
      .set('Authorization', 'Bearer valid-token')
      .send({ name: 'Car 1', plate: 'ABC-123' })
      .expect(201)
      .expect((res) => {
        expect(res.body.name).toBe('Car 1');
        expect(res.body.id).toBeDefined();
      });
  });

  it('GET /mobiles should return items after creation', async () => {
    await request(app.getHttpServer())
      .post('/mobiles')
      .set('Authorization', 'Bearer valid-token')
      .send({ name: 'Car 2' });

    const res = await request(app.getHttpServer())
      .get('/mobiles')
      .set('Authorization', 'Bearer valid-token')
      .expect(200);

    expect(res.body.length).toBeGreaterThan(0);
  });
});
