import {
  createDependencyDetector,
  createEnvDetector,
  createFileDetector,
  registerDetector,
} from "./detect";

registerDetector(
  createDependencyDetector("react", "React", ["react", "react-dom", "next"])
);

registerDetector(createDependencyDetector("next", "Next.js", ["next"]));

registerDetector(
  createDependencyDetector("nestjs", "NestJS", [
    "@nestjs/core",
    "@nestjs/common",
  ])
);

registerDetector(createDependencyDetector("express", "Express", ["express"]));

registerDetector(
  createDependencyDetector("mongoose", "Mongoose (MongoDB)", ["mongoose"])
);

registerDetector(
  createDependencyDetector("mongodb", "MongoDB Driver", ["mongodb"])
);

registerDetector(
  createEnvDetector("mongodb-env", "MongoDB (env)", [
    /MONGODB_URI/i,
    /MONGO_URI/i,
    /MONGO_URL/i,
  ])
);

registerDetector(
  createFileDetector("prisma", "Prisma", [
    "prisma/schema.prisma",
    "prisma/migrations",
  ])
);

registerDetector(
  createDependencyDetector("postgresql", "PostgreSQL", [
    "pg",
    "sequelize",
    "typeorm",
  ])
);

registerDetector(
  createEnvDetector("postgres-env", "PostgreSQL (env)", [
    /POSTGRES_URI/i,
    /POSTGRES_URL/i,
    /DATABASE_URL.*postgres/i,
  ])
);
