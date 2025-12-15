/**
 * Sowntra Backend Server
 * 
 * Features:
 * - User management and authentication (Firebase)
 * - Board CRUD operations (design projects)
 * - Project data save/load/autosave
 * - Version control and snapshots
 * - Asset upload to Firebase Storage
 * - Collaboration with role-based access
 * - Health monitoring and statistics
 * 
 * API Base: http://localhost:3001
 * 
 * Main Routes:
 * - /api/users       User profile & search
 * - /api/boards      Board management
 * - /api/projects    Save/load design data
 * - /api/assets      File uploads
 * - /api/health      Server status
 */

import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import http from 'http';
import boardRoutes from './routes/board.routes';
import assetRoutes from './routes/asset.routes';
import userRoutes from './routes/user.routes';
import projectRoutes from './routes/project.routes';
import healthRoutes from './routes/health.routes';
import invitationRoutes from './routes/invitation.routes';
import { initWebSocketServer } from './websocket/collaboration';
import { prisma } from './config/database';

dotenv.config();

const app: Express = express();
const PORT = process.env.PORT || 4001;

const server = http.createServer(app);

// Define allowed origins
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:4173',
  'http://localhost:5173',
  'https://sowntra.com',
  'https://www.sowntra.com',
  'http://sowntra.com',
  'http://www.sowntra.com',
  'sowntra.com',
  'www.sowntra.com'
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Content-Length', 'X-Foo', 'X-Bar']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req: Request, _res: Response, next) => {
  console.log(`${req.method} ${req.path}`);
  next();
});

app.get('/', (_req: Request, res: Response) => {
  res.json({ 
    name: 'Sowntra API',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/api/health',
      users: '/api/users',
      boards: '/api/boards',
      projects: '/api/projects',
      assets: '/api/assets',
      invitations: '/api/invitations'
    }
  });
});

// CORS test endpoint
app.get('/api/cors-test', (_req: Request, res: Response) => {
  res.json({ 
    message: 'CORS is working!',
    origin: _req.headers.origin,
    timestamp: new Date().toISOString()
  });
});

app.use('/api/health', healthRoutes);
app.use('/api/boards', boardRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/users', userRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/invitations', invitationRoutes);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err: Error, _req: Request, res: Response, _next: any) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

if (process.env.ENABLE_WEBSOCKET !== 'false') {
  initWebSocketServer(server);
}

server.listen(PORT, async () => {
  console.log('🚀 Sowntra Backend Server');
  console.log(`📡 HTTP Server: http://localhost:${PORT}`);
  if (process.env.ENABLE_WEBSOCKET !== 'false') {
    console.log(`🔌 WebSocket Server: ws://localhost:${PORT}/collaboration`);
  }
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  
  try {
    await prisma.$connect();
    console.log('✅ Database connected successfully');
  } catch (error) {
    console.error('❌ Database connection failed:', error);
    console.log('⚠️  Server running without database connection');
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(async () => {
    await prisma.$disconnect();
    console.log('HTTP server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT signal received: closing HTTP server');
  server.close(async () => {
    await prisma.$disconnect();
    console.log('HTTP server closed');
    process.exit(0);
  });
});

export default app;

