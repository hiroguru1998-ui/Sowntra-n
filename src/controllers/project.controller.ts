import { Request, Response } from 'express';
import { prisma } from '../config/database';

/**
 * Save design project data (user projects without boardId)
 */
export async function saveProjectData(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.dbUserId;
    const { projectData } = req.body;
    const { boardId } = req.params;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    if (!projectData) {
      res.status(400).json({ error: 'Project data is required' });
      return;
    }

    // If boardId is provided, use board-based saving
    if (boardId) {
      const board = await prisma.board.findUnique({
        where: { id: boardId },
        include: { members: true }
      });

      if (!board) {
        res.status(404).json({ error: 'Board not found' });
        return;
      }

      const hasAccess = 
        board.ownerId === userId ||
        board.members.some(m => m.userId === userId && m.role !== 'viewer');

      if (!hasAccess) {
        res.status(403).json({ error: 'Access denied' });
        return;
      }

      const updatedBoard = await prisma.board.update({
        where: { id: boardId },
        data: {
          yDocState: Buffer.from(JSON.stringify(projectData)),
          lastModified: new Date()
        },
        select: {
          id: true,
          title: true,
          lastModified: true
        }
      });

      res.json({
        message: 'Project data saved successfully',
        board: updatedBoard
      });
    } else {
      // User project saving (without boardId)
      const project = await prisma.board.create({
        data: {
          title: projectData.title || `Untitled Project ${new Date().toLocaleDateString()}`,
          description: projectData.description || '',
          ownerId: userId,
          isPublic: false,
          yDocState: Buffer.from(JSON.stringify(projectData)),
          lastModified: new Date()
        },
        select: {
          id: true,
          title: true,
          lastModified: true
        }
      });

      res.json({
        message: 'Project saved successfully',
        project: project
      });
    }
  } catch (error) {
    console.error('Error saving project data:', error);
    res.status(500).json({ error: 'Failed to save project data' });
  }
}

/**
 * Load design project data
 */
export async function loadProjectData(req: Request, res: Response): Promise<void> {
  try {
    const { boardId } = req.params;
    const userId = req.user?.dbUserId;

    const board = await prisma.board.findUnique({
      where: { id: boardId },
      include: {
        members: true,
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            profileImage: true
          }
        },
        assets: {
          orderBy: { uploadedAt: 'desc' }
        }
      }
    });

    if (!board) {
      res.status(404).json({ error: 'Board not found' });
      return;
    }

    const hasAccess = 
      board.isPublic ||
      board.ownerId === userId ||
      (userId && board.members.some(m => m.userId === userId));

    if (!hasAccess) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    let projectData = null;
    if (board.yDocState) {
      try {
        // Handle Prisma Bytes type - convert Buffer to string then parse JSON
        const yDocStateString = Buffer.isBuffer(board.yDocState) 
          ? board.yDocState.toString('utf8')
          : String(board.yDocState);
        
        if (yDocStateString && yDocStateString.trim()) {
          projectData = JSON.parse(yDocStateString);
        } else {
          projectData = { elements: [], pages: [] };
        }
      } catch (parseError) {
        console.error('Error parsing board project data:', parseError);
        projectData = { elements: [], pages: [] };
      }
    }

    res.json({
      board: {
        id: board.id,
        title: board.title,
        description: board.description,
        thumbnail: board.thumbnail,
        isPublic: board.isPublic,
        owner: board.owner,
        members: board.members,
        assets: board.assets,
        createdAt: board.createdAt,
        lastModified: board.lastModified
      },
      projectData
    });
  } catch (error) {
    console.error('Error loading project data:', error);
    res.status(500).json({ error: 'Failed to load project data' });
  }
}

/**
 * Auto-save project data (lightweight save without version)
 */
export async function autoSaveProjectData(req: Request, res: Response): Promise<void> {
  try {
    const { boardId } = req.params;
    const userId = req.user?.dbUserId;
    const { projectData } = req.body;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const board = await prisma.board.findUnique({
      where: { id: boardId },
      include: { members: true }
    });

    if (!board) {
      res.status(404).json({ error: 'Board not found' });
      return;
    }

    const hasAccess = 
      board.ownerId === userId ||
      board.members.some(m => m.userId === userId && m.role !== 'viewer');

    if (!hasAccess) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    await prisma.board.update({
      where: { id: boardId },
      data: {
        yDocState: Buffer.from(JSON.stringify(projectData)),
        lastModified: new Date()
      }
    });

    res.json({ message: 'Auto-saved successfully' });
  } catch (error) {
    console.error('Error auto-saving project data:', error);
    res.status(500).json({ error: 'Failed to auto-save project data' });
  }
}

/**
 * Create project version/snapshot
 */
export async function createProjectVersion(req: Request, res: Response): Promise<void> {
  try {
    const { boardId } = req.params;
    const userId = req.user?.dbUserId;
    const { versionName, thumbnail } = req.body;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const board = await prisma.board.findUnique({
      where: { id: boardId }
    });

    if (!board) {
      res.status(404).json({ error: 'Board not found' });
      return;
    }

    if (board.ownerId !== userId) {
      res.status(403).json({ error: 'Only the owner can create versions' });
      return;
    }

    if (!board.yDocState) {
      res.status(400).json({ error: 'No project data to save as version' });
      return;
    }

    const version = await prisma.boardVersion.create({
      data: {
        boardId,
        versionName: versionName || `Version ${new Date().toISOString()}`,
        yDocState: board.yDocState,
        thumbnail: thumbnail || board.thumbnail
      }
    });

    res.status(201).json(version);
  } catch (error) {
    console.error('Error creating project version:', error);
    res.status(500).json({ error: 'Failed to create project version' });
  }
}

/**
 * Get project version history
 */
export async function getProjectVersions(req: Request, res: Response): Promise<void> {
  try {
    const { boardId } = req.params;
    const userId = req.user?.dbUserId;

    const board = await prisma.board.findUnique({
      where: { id: boardId },
      include: { members: true }
    });

    if (!board) {
      res.status(404).json({ error: 'Board not found' });
      return;
    }

    const hasAccess = 
      board.ownerId === userId ||
      (userId && board.members.some(m => m.userId === userId));

    if (!hasAccess) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    const versions = await prisma.boardVersion.findMany({
      where: { boardId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        versionName: true,
        thumbnail: true,
        createdAt: true
      }
    });

    res.json(versions);
  } catch (error) {
    console.error('Error fetching project versions:', error);
    res.status(500).json({ error: 'Failed to fetch project versions' });
  }
}

/**
 * Restore project from version
 */
export async function restoreProjectVersion(req: Request, res: Response): Promise<void> {
  try {
    const { boardId, versionId } = req.params;
    const userId = req.user?.dbUserId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const board = await prisma.board.findUnique({
      where: { id: boardId }
    });

    if (!board) {
      res.status(404).json({ error: 'Board not found' });
      return;
    }

    if (board.ownerId !== userId) {
      res.status(403).json({ error: 'Only the owner can restore versions' });
      return;
    }

    const version = await prisma.boardVersion.findUnique({
      where: { id: versionId }
    });

    if (!version || version.boardId !== boardId) {
      res.status(404).json({ error: 'Version not found' });
      return;
    }

    await prisma.board.update({
      where: { id: boardId },
      data: {
        yDocState: version.yDocState,
        lastModified: new Date()
      }
    });

    res.json({ message: 'Project restored from version successfully' });
  } catch (error) {
    console.error('Error restoring project version:', error);
    res.status(500).json({ error: 'Failed to restore project version' });
  }
}

/**
 * Get user's projects (boards)
 */
export async function getUserProjects(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user?.dbUserId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const projects = await prisma.board.findMany({
      where: {
        OR: [
          { ownerId: userId },
          { members: { some: { userId } } }
        ]
      },
      select: {
        id: true,
        title: true,
        description: true,
        isPublic: true,
        createdAt: true,
        lastModified: true,
        owner: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      },
      orderBy: { lastModified: 'desc' }
    });

    res.json({ projects });
  } catch (error) {
    console.error('Error getting user projects:', error);
    res.status(500).json({ error: 'Failed to get user projects' });
  }
}

/**
 * Load user project by ID
 */
export async function loadUserProject(req: Request, res: Response): Promise<void> {
  try {
    const { projectId } = req.params;
    const userId = req.user?.dbUserId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const project = await prisma.board.findFirst({
      where: {
        id: projectId,
        OR: [
          { ownerId: userId },
          { members: { some: { userId } } }
        ]
      },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true
          }
        }
      }
    });

    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    let projectData = {};
    if (project.yDocState) {
      try {
        // Handle Prisma Bytes type - convert Buffer to string then parse JSON
        const yDocStateString = Buffer.isBuffer(project.yDocState) 
          ? project.yDocState.toString('utf8')
          : String(project.yDocState);
        
        if (yDocStateString && yDocStateString.trim()) {
          projectData = JSON.parse(yDocStateString);
        }
      } catch (parseError) {
        console.error('Error parsing project data:', parseError);
        // Return empty project data if parsing fails
        projectData = {};
      }
    }

    res.json({
      project: {
        id: project.id,
        title: project.title,
        description: project.description,
        lastModified: project.lastModified,
        owner: project.owner
      },
      projectData
    });
  } catch (error) {
    console.error('Error loading user project:', error);
    res.status(500).json({ error: 'Failed to load project' });
  }
}

/**
 * Update user project
 */
export async function updateUserProject(req: Request, res: Response): Promise<void> {
  try {
    const { projectId } = req.params;
    const userId = req.user?.dbUserId;
    const { projectData } = req.body;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const project = await prisma.board.findFirst({
      where: {
        id: projectId,
        ownerId: userId
      }
    });

    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const updatedProject = await prisma.board.update({
      where: { id: projectId },
      data: {
        yDocState: Buffer.from(JSON.stringify(projectData)),
        lastModified: new Date()
      },
      select: {
        id: true,
        title: true,
        lastModified: true
      }
    });

    res.json({
      message: 'Project updated successfully',
      project: updatedProject
    });
  } catch (error) {
    console.error('Error updating project:', error);
    res.status(500).json({ error: 'Failed to update project' });
  }
}

/**
 * Delete user project
 */
export async function deleteUserProject(req: Request, res: Response): Promise<void> {
  try {
    const { projectId } = req.params;
    const userId = req.user?.dbUserId;

    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const project = await prisma.board.findFirst({
      where: {
        id: projectId,
        ownerId: userId
      }
    });

    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    await prisma.board.delete({
      where: { id: projectId }
    });

    res.json({ message: 'Project deleted successfully' });
  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({ error: 'Failed to delete project' });
  }
}

