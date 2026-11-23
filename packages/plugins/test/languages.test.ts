import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze, createStageContext, DEFAULT_CONFIG, type ReviewPlan } from '@bowi/core';
import { scratchRepo } from '@bowi/fixtures';
import { defaultRules } from '@bowi/rules';
import { openLocalSnapshot } from '@bowi/sources';
import { routesOn } from '../src/go-http.ts';
import { defaultPlugins } from '../src/index.ts';

// Frameworks of Python, Go, Java, Kotlin and C# (M17).

// scratchRepo returns `<its own temporary folder>/repo`: remove that folder, nothing above it.
const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function review(
  base: Record<string, string>,
  head: Record<string, string | null>,
): Promise<ReviewPlan> {
  const repo = scratchRepo(base, head);
  roots.push(dirname(repo));
  return analyze(await openLocalSnapshot({ cwd: repo }), createStageContext(DEFAULT_CONFIG), {
    toolVersion: 'test',
    plugins: defaultPlugins,
    hintRules: defaultRules,
  });
}

const lines = (...l: string[]) => `${l.join('\n')}\n`;
const layers = (plan: ReviewPlan) => Object.fromEntries(plan.files.map((f) => [f.path, f.layer]));
const framework = (plan: ReviewPlan) =>
  plan.edges.filter((e) => e.type === 'framework').map((e) => e.evidence.text);
const messages = (plan: ReviewPlan) => plan.hints.map((h) => h.message);

describe('Spring Boot', () => {
  it('reads layers from annotations, routes, method security, and migrations of entity fields', async () => {
    const controller = (extra: string[]) =>
      lines(
        'package com.acme.orders;',
        '',
        'import org.springframework.web.bind.annotation.*;',
        '',
        '@RestController',
        '@RequestMapping("/api/orders")',
        'public class OrderController {',
        '    @GetMapping("/{id}")',
        '    public Order get(@PathVariable long id) {',
        '        return null;',
        '    }',
        ...extra,
        '}',
      );
    const plan = await review(
      {
        'pom.xml':
          '<project>\n  <parent><artifactId>spring-boot-starter-parent</artifactId></parent>\n</project>\n',
        'src/main/java/com/acme/orders/OrderController.java': controller([]),
        'src/main/java/com/acme/orders/Order.java': lines(
          'package com.acme.orders;',
          '',
          '@Entity',
          'public class Order {',
          '    @Id',
          '    private Long id;',
          '}',
        ),
      },
      {
        'src/main/java/com/acme/orders/OrderController.java': controller([
          '',
          '    @PostMapping(value = "/", produces = "application/json")',
          '    @PreAuthorize("hasRole(\'ADMIN\')")',
          '    public Order create(@RequestBody Order order) {',
          '        return order;',
          '    }',
        ]),
        'src/main/java/com/acme/orders/Order.java': lines(
          'package com.acme.orders;',
          '',
          '@Entity',
          'public class Order {',
          '    @Id',
          '    private Long id;',
          '    private String paidAt;',
          '}',
        ),
        'src/main/java/com/acme/orders/OrderRepository.java': lines(
          'package com.acme.orders;',
          '',
          'public interface OrderRepository extends JpaRepository<Order, Long> {}',
        ),
        'src/main/java/com/acme/orders/OrderService.java': lines(
          'package com.acme.orders;',
          '',
          '@Service',
          'public class OrderService {}',
        ),
        'src/main/java/com/acme/AppConfig.java': lines(
          'package com.acme;',
          '',
          '@Configuration',
          'public class AppConfig {}',
        ),
        'src/main/resources/db/migration/V2__order_paid_at.sql':
          'ALTER TABLE orders ADD COLUMN paid_at VARCHAR(40);\n',
        'src/main/resources/db/changelog/002-orders.yaml': 'databaseChangeLog: []\n',
      },
    );
    expect(plan.meta.plugins).toEqual(['spring']);
    expect(layers(plan)).toMatchObject({
      'src/main/java/com/acme/orders/OrderController.java': 'api',
      'src/main/java/com/acme/orders/Order.java': 'data',
      'src/main/java/com/acme/orders/OrderRepository.java': 'data',
      'src/main/java/com/acme/orders/OrderService.java': 'service',
      'src/main/java/com/acme/AppConfig.java': 'config',
      'src/main/resources/db/changelog/002-orders.yaml': 'schema',
    });
    expect(messages(plan)).toEqual(
      expect.arrayContaining([
        'New route: POST /api/orders',
        'Access control changed: `@PreAuthorize("hasRole(\'ADMIN\')")` on `OrderController.create()`',
      ]),
    );
    expect(messages(plan)).not.toContain('Route handler changed: GET /api/orders/{id}');
    expect(framework(plan)).toEqual([
      '`src/main/resources/db/migration/V2__order_paid_at.sql` changes `paid_at` of `Order`',
    ]);
  });

  it('reads Kotlin controllers too', async () => {
    const plan = await review(
      { 'build.gradle.kts': 'plugins {\n    id("org.springframework.boot") version "3.4.0"\n}\n' },
      {
        'src/main/kotlin/acme/UserController.kt': lines(
          'package acme',
          '',
          '@RestController',
          '@RequestMapping("/users")',
          'class UserController {',
          '    @DeleteMapping("/{id}")',
          '    fun delete(id: Long) {}',
          '}',
        ),
      },
    );
    expect(layers(plan)['src/main/kotlin/acme/UserController.kt']).toBe('api');
    expect(messages(plan)).toContain('New route: DELETE /users/{id}');
  });
});

describe('ASP.NET Core', () => {
  it('reads controllers, DbContexts, attribute routes, minimal APIs and DI registrations', async () => {
    const controller = (extra: string[]) =>
      lines(
        'using Microsoft.AspNetCore.Mvc;',
        '',
        'namespace Api.Controllers;',
        '',
        '[ApiController]',
        '[Route("api/[controller]")]',
        'public class OrdersController : ControllerBase',
        '{',
        '    [HttpGet("{id}")]',
        '    public IActionResult Get(int id) => Ok(id);',
        ...extra,
        '}',
      );
    const program = (extra: string[]) =>
      lines(
        'var builder = WebApplication.CreateBuilder(args);',
        ...extra,
        'var app = builder.Build();',
        'app.MapControllers();',
        'app.Run();',
      );
    const plan = await review(
      {
        'src/Api/Api.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web">\n</Project>\n',
        'src/Api/Controllers/OrdersController.cs': controller([]),
        'src/Api/Program.cs': program([]),
        'src/Api/Entities/Order.cs': lines(
          'namespace Api;',
          '',
          'public class Order',
          '{',
          '    public int Id { get; set; }',
          '}',
        ),
      },
      {
        'src/Api/Controllers/OrdersController.cs': controller([
          '',
          '    [HttpPost]',
          '    [Authorize(Roles = "Admin")]',
          '    public IActionResult Create(object order) => Ok(order);',
        ]),
        'src/Api/Program.cs': program([
          'builder.Services.AddSingleton<IMailer, Mailer>();',
          'app.MapGet("/health", () => "ok");',
        ]),
        'src/Api/Services/Mailer.cs': lines(
          'namespace Api;',
          '',
          'public interface IMailer',
          '{',
          '    void Send(object order);',
          '}',
          '',
          'public class Mailer : IMailer',
          '{',
          '    public void Send(object order) { }',
          '}',
        ),
        'src/Api/Data/AppDbContext.cs': lines(
          'using Microsoft.EntityFrameworkCore;',
          '',
          'namespace Api.Data;',
          '',
          'public class AppDbContext : DbContext',
          '{',
          '}',
        ),
        'src/Api/Entities/Order.cs': lines(
          'namespace Api;',
          '',
          'public class Order',
          '{',
          '    public int Id { get; set; }',
          '    public DateTime? PaidAt { get; set; }',
          '}',
        ),
        'src/Api/Entities/Limits.cs': lines(
          'namespace Api;',
          '',
          'public static class Limits',
          '{',
          '    public const int Orders = 100;',
          '}',
        ),
        'src/Api/Migrations/20261122_OrderPaidAt.cs': lines(
          'using Microsoft.EntityFrameworkCore.Migrations;',
          '',
          'public partial class OrderPaidAt : Migration',
          '{',
          '    protected override void Up(MigrationBuilder b)',
          '    {',
          '        b.AddColumn<DateTime>(name: "PaidAt", table: "Orders", nullable: true);',
          '    }',
          '}',
        ),
      },
    );
    expect(plan.meta.plugins).toEqual(['aspnetcore']);
    expect(layers(plan)).toMatchObject({
      'src/Api/Controllers/OrdersController.cs': 'api',
      'src/Api/Program.cs': 'api',
      'src/Api/Data/AppDbContext.cs': 'data',
      'src/Api/Migrations/20261122_OrderPaidAt.cs': 'schema',
    });
    expect(messages(plan)).toEqual(
      expect.arrayContaining([
        'New route: POST /api/Orders',
        'New route: GET /health',
        'Access control changed: `[Authorize(Roles = "Admin")]` on `OrdersController.Create()`',
      ]),
    );
    expect(framework(plan)).toEqual(
      expect.arrayContaining([
        '`src/Api/Program.cs` registers `Mailer` as `IMailer`',
        '`OrderPaidAt` in `src/Api/Migrations/20261122_OrderPaidAt.cs` changes `PaidAt` of `Order`',
      ]),
    );
    // A constant is not a column, though the migration names the `Orders` table.
    expect(framework(plan).filter((t) => t.includes('`Limits`'))).toEqual([]);
  });
});

describe('Django', () => {
  it('reads models and views, links URL patterns and migrations, hints routes and access', async () => {
    const plan = await review(
      {
        'requirements.txt': 'Django==5.0\n',
        'shop/__init__.py': '',
        'shop/views.py': lines(
          'from django.http import HttpResponse',
          '',
          '',
          'def home(request):',
          "    return HttpResponse('hi')",
        ),
        'shop/urls.py': lines(
          'from django.urls import include, path',
          'from . import views',
          '',
          'urlpatterns = [',
          "    path('', views.home),",
          ']',
        ),
        'shop/models.py': lines(
          'from django.db import models',
          '',
          '',
          'class Order(models.Model):',
          '    total = models.IntegerField()',
        ),
      },
      {
        'shop/views.py': lines(
          'from django.http import HttpResponse',
          'from django.contrib.auth.decorators import login_required',
          '',
          '',
          'def home(request):',
          "    return HttpResponse('hi')",
          '',
          '',
          '@login_required',
          'def billing(request):',
          "    return HttpResponse('bill')",
        ),
        'shop/urls.py': lines(
          'from django.urls import include, path',
          'from . import views',
          '',
          'urlpatterns = [',
          "    path('', views.home),",
          "    path('settings/billing/', views.billing, name='billing'),",
          "    path('api/', include('shop.api.urls')),",
          ']',
        ),
        'shop/models.py': lines(
          'from django.db import models',
          '',
          '',
          'class Order(models.Model):',
          '    total = models.IntegerField()',
          '    paid_at = models.DateTimeField(null=True)',
        ),
        'shop/migrations/0002_order_paid_at.py': lines(
          'from django.db import migrations, models',
          '',
          '',
          'class Migration(migrations.Migration):',
          "    dependencies = [('shop', '0001_initial')]",
          '    operations = [',
          "        migrations.AddField(model_name='order', name='paid_at', field=models.DateTimeField(null=True)),",
          '    ]',
        ),
        'shop/settings.py': 'DEBUG = False\n',
      },
    );
    expect(plan.meta.plugins).toEqual(['django']);
    expect(layers(plan)).toMatchObject({
      'shop/views.py': 'api',
      'shop/urls.py': 'api',
      'shop/models.py': 'data',
      'shop/migrations/0002_order_paid_at.py': 'schema',
      'shop/settings.py': 'config',
    });
    expect(framework(plan)).toEqual(
      expect.arrayContaining([
        '`urlpatterns` in `shop/urls.py` routes `/settings/billing/` to `billing()` in `shop/views.py`',
        '`Migration` in `shop/migrations/0002_order_paid_at.py` changes `paid_at` of `Order`',
      ]),
    );
    const routes = messages(plan).filter((m) => m.includes('route'));
    expect(routes).toEqual(['New route: /settings/billing/']);
    expect(messages(plan)).toContain('Access control changed: `@login_required` on `billing()`');
  });
});

describe('FastAPI and Flask', () => {
  it('FastAPI: routes with the router prefix, models, and a mounted router', async () => {
    const plan = await review(
      {
        'pyproject.toml': '[project]\nname = "shop"\ndependencies = ["fastapi>=0.110"]\n',
        'app/__init__.py': '',
        'app/main.py': lines('from fastapi import FastAPI', '', 'app = FastAPI()'),
      },
      {
        'app/main.py': lines(
          'from fastapi import FastAPI',
          '',
          'from .routers import orders',
          '',
          'app = FastAPI()',
          'app.include_router(orders.router)',
        ),
        'app/routers/__init__.py': '',
        'app/routers/orders.py': lines(
          'from fastapi import APIRouter',
          '',
          'from ..schemas import OrderIn',
          '',
          'router = APIRouter(prefix="/orders", tags=["orders"])',
          '',
          '',
          '@router.post("/", status_code=201)',
          'def create_order(order: OrderIn):',
          '    return order',
        ),
        'app/schemas.py': lines(
          'from pydantic import BaseModel',
          '',
          '',
          'class OrderIn(BaseModel):',
          '    total: int',
        ),
      },
    );
    expect(plan.meta.plugins).toEqual(['fastapi']);
    expect(layers(plan)).toMatchObject({
      'app/main.py': 'api',
      'app/routers/orders.py': 'api',
      'app/schemas.py': 'data',
    });
    expect(framework(plan)).toContain('`app/main.py` mounts `orders` from `app/routers/orders.py`');
    expect(messages(plan).filter((m) => m.includes('route'))).toEqual(['New route: POST /orders/']);
  });

  it('Flask: blueprints with their methods, login_required, and register_blueprint', async () => {
    const plan = await review(
      {
        'requirements.txt': 'Flask==3.0\nflask-login\n',
        'shop/__init__.py': lines(
          'from flask import Flask',
          '',
          '',
          'def create_app():',
          '    app = Flask(__name__)',
          '    return app',
        ),
      },
      {
        'shop/__init__.py': lines(
          'from flask import Flask',
          '',
          'from .orders import bp',
          '',
          '',
          'def create_app():',
          '    app = Flask(__name__)',
          '    app.register_blueprint(bp)',
          '    return app',
        ),
        'shop/orders.py': lines(
          'from flask import Blueprint',
          'from flask_login import login_required',
          '',
          'bp = Blueprint("orders", __name__)',
          '',
          '',
          '@bp.route("/orders", methods=["GET", "POST"])',
          '@login_required',
          'def orders():',
          '    return "ok"',
        ),
      },
    );
    expect(plan.meta.plugins).toEqual(['flask']);
    expect(layers(plan)).toMatchObject({ 'shop/__init__.py': 'api', 'shop/orders.py': 'api' });
    expect(framework(plan)).toContain(
      '`create_app()` in `shop/__init__.py` mounts `bp` from `shop/orders.py`',
    );
    expect(messages(plan)).toEqual(
      expect.arrayContaining([
        'New route: GET, POST /orders',
        'Access control changed: `@login_required` on `orders()`',
      ]),
    );
  });
});

describe('Go HTTP', () => {
  it('reads handlers, links a route to the handler it names, and hints the route', async () => {
    const main = (extra: string[]) =>
      lines(
        'package main',
        '',
        'import (',
        '\t"net/http"',
        '',
        '\t"example.com/app/handlers"',
        '\t"github.com/go-chi/chi/v5"',
        ')',
        '',
        'func main() {',
        '\tr := chi.NewRouter()',
        '\tr.Get("/", handlers.Home)',
        ...extra,
        '\thttp.ListenAndServe(":3000", r)',
        '}',
      );
    const plan = await review(
      {
        'go.mod': 'module example.com/app\n\ngo 1.22\n\nrequire github.com/go-chi/chi/v5 v5.0.0\n',
        'main.go': main([]),
        'handlers/home.go': lines(
          'package handlers',
          '',
          'import "net/http"',
          '',
          'func Home(w http.ResponseWriter, r *http.Request) {}',
        ),
      },
      {
        'main.go': main(['\tr.Post("/orders", handlers.CreateOrder)']),
        'handlers/orders.go': lines(
          'package handlers',
          '',
          'import "net/http"',
          '',
          'func CreateOrder(w http.ResponseWriter, r *http.Request) {',
          '\tw.WriteHeader(http.StatusCreated)',
          '}',
        ),
      },
    );
    expect(plan.meta.plugins).toEqual(['go-http']);
    expect(layers(plan)).toMatchObject({ 'main.go': 'api', 'handlers/orders.go': 'api' });
    expect(framework(plan)).toEqual([
      '`main()` in `main.go` routes `POST /orders` to `CreateOrder()` in `handlers/orders.go`',
    ]);
    expect(messages(plan)).toEqual(['New route: POST /orders']);
  });

  it('reads the routes of net/http, Gin, Echo, chi and gorilla/mux', () => {
    expect(routesOn('router.GET("/users/:id", getUser)')).toEqual(['GET /users/:id']);
    expect(routesOn('e.POST("/users", createUser)')).toEqual(['POST /users']);
    expect(routesOn('mux.HandleFunc("GET /items/{id}", item)')).toEqual(['GET /items/{id}']);
    expect(routesOn('http.HandleFunc("/static/", static)')).toEqual(['/static/']);
    expect(routesOn('r.Method("PATCH", "/items", h)')).toEqual(['PATCH /items']);
    expect(routesOn('r.HandleFunc("/items", h).Methods("PUT")')).toEqual(['PUT /items']);
    expect(routesOn('resp, err := http.Get("https://example.com/")')).toEqual([]);
    expect(routesOn('v := cache.Get(key)')).toEqual([]);
  });
});
