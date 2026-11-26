---
architecture:
  name: production-boundaries
  environment: PRODUCTION
  cluster: primary
  components:
    - id: catalog
      type: application
      name: Product Catalog API
      technology: spring-boot
    - id: supplier
      type: external-source
      name: Supplier Feed
    - id: lake
      type: object-storage
      name: analytics-inventory
  relationships:
    - from: supplier
      to: catalog
      type: WRITES_TO
    - from: catalog
      to: lake
      type: WRITES_TO
---

# Production boundaries

This note documents systems whose relationship is not available in deploy-time configuration.
