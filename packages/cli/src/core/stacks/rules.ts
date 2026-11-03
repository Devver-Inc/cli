import { rule as adonis } from "./adonis";
import { rule as astro } from "./astro";
import { rule as express } from "./express";
import { rule as fastify } from "./fastify";
import { rule as hono } from "./hono";
import { rule as nestjs } from "./nestjs";
import { rule as next } from "./next";
import { rule as nuxt } from "./nuxt";
import { rule as remix } from "./remix";
import { rule as sveltekit } from "./sveltekit";
import { rule as tanstackStart } from "./tanstack-start";
import { rule as vite } from "./vite";

export const stackRules = [
  next,
  tanstackStart,
  astro,
  nuxt,
  sveltekit,
  remix,
  express,
  hono,
  nestjs,
  adonis,
  fastify,
  vite,
];
