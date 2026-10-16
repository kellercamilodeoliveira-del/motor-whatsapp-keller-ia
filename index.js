require("dotenv").config();
const express = require("express");
const fs = require("fs");
const path = require("path");
const pino = require("pino");
const Groq = require("groq-sdk");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");

const EMPRESAS_DIR = path.join(__dirname, "empresas");
const AUTH_DIR = path.join(__dirname, "auth_info");
const PORT = process.env.PORT || 3000;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const historico =


